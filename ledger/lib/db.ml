(* Thin wrapper over libpq. Calls block, so callers run them in a system
   thread or in their own domain, never directly on the Eio event loop. *)

exception Db_error of string

type t = { conninfo : string; mutable conn : Postgresql.connection }

let open_connection conninfo =
  try new Postgresql.connection ~conninfo ()
  with Postgresql.Error e -> raise (Db_error (Postgresql.string_of_error e))

let connect conninfo = { conninfo; conn = open_connection conninfo }

let close t = try t.conn#finish with _ -> ()

(* Replaces a broken connection. Call it between transactions only. *)
let ensure t =
  let alive = try t.conn#status = Postgresql.Ok with _ -> false in
  if not alive then (
    close t;
    t.conn <- open_connection t.conninfo)

let null = Postgresql.null
let opt = function Some s -> s | None -> Postgresql.null

let exec t ?(params = [||]) sql : Postgresql.result =
  match t.conn#exec ~params sql with
  | exception Postgresql.Error e -> raise (Db_error (Postgresql.string_of_error e))
  | r -> (
      match r#status with
      | Postgresql.Command_ok | Postgresql.Tuples_ok -> r
      | _ -> raise (Db_error (String.trim r#error)))

let rows (r : Postgresql.result) : int = r#ntuples
let get (r : Postgresql.result) i j : string = r#getvalue i j
let get_opt (r : Postgresql.result) i j : string option =
  if r#getisnull i j then None else Some (r#getvalue i j)
let get_int r i j = int_of_string (get r i j)

(* Runs [f] inside one transaction. Any exception rolls it back. *)
let transaction t (f : unit -> 'a) : 'a =
  ensure t;
  ignore (exec t "BEGIN");
  match f () with
  | v ->
      ignore (exec t "COMMIT");
      v
  | exception e ->
      (try ignore (exec t "ROLLBACK") with _ -> ());
      raise e
