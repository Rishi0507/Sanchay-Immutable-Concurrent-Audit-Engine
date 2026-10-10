(* The trail chain: one hash-chained entry per tool call by any identity
   (PRD section 16.4). It runs on its own sequencer and its own connection,
   with the same single-writer rule as the business chain (LC-9). *)

type t = {
  db : Db.t;
  sequencer : Sequencer.t;
  mutable head_seq : int;
  mutable head_hash : string;
}

type entry = {
  identity : Identity.t;
  tool : string;
  args_hash : string;
  result_hash : string;
  status : string;
  engagement_id : string option;
}

let member name (j : Yojson.Safe.t) =
  match j with `Assoc fields -> List.assoc_opt name fields | _ -> None

let is_hex64 s =
  String.length s = 64
  && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) s

let parse (body : Yojson.Safe.t) : (entry, Error.t) result =
  let ( let* ) = Result.bind in
  let str name =
    match member name body with
    | Some (`String s) when s <> "" -> Ok s
    | _ -> Error.fail Error.Validation_failed "%s is required." name
  in
  let hash name =
    let* s = str name in
    if is_hex64 s then Ok s
    else Error.fail Error.Validation_failed "%s must be 64 lower-case hexadecimal characters." name
  in
  let* tool = str "tool" in
  let* status = str "status" in
  let* args_hash = hash "args_hash" in
  let* result_hash = hash "result_hash" in
  let* identity =
    match member "identity" body with
    | Some j -> Identity.of_json j
    | None -> Error.fail Error.Validation_failed "identity is required."
  in
  let engagement_id =
    match member "engagement_id" body with Some (`String s) when s <> "" -> Some s | _ -> None
  in
  Ok { identity; tool; args_hash; result_hash; status; engagement_id }

let content ~trail_seq ~ts ~user ~role ~tool ~args_hash ~result_hash ~status ~engagement_id :
    Yojson.Safe.t =
  `Assoc
    [
      ("args_hash", `String args_hash);
      ("engagement_id", match engagement_id with Some s -> `String s | None -> `Null);
      ("identity", `Assoc [ ("role", `String role); ("user", `String user) ]);
      ("result_hash", `String result_hash);
      ("status", `String status);
      ("tool", `String tool);
      ("trail_seq", `Int trail_seq);
      ("ts", `String ts);
    ]

let create ~sw ~conninfo : t =
  let db = Db.connect conninfo in
  let r =
    Db.exec db "SELECT trail_seq, hash FROM trail.entries ORDER BY trail_seq DESC LIMIT 1"
  in
  let head_seq, head_hash =
    if Db.rows r = 0 then (0, Hash.genesis) else (Db.get_int r 0 0, Db.get r 0 1)
  in
  { db; sequencer = Sequencer.create ~sw (); head_seq; head_hash }

let append (t : t) (e : entry) : (int * string, Error.t) result =
  Sequencer.submit t.sequencer (fun () ->
      let trail_seq = t.head_seq + 1 in
      let prev_hash = t.head_hash in
      let ts = Clock.now_utc () in
      let user = e.identity.Identity.user in
      let role = Identity.role_string e.identity.Identity.role in
      let hash =
        Hash.chain ~prev_hash
          ~content:
            (content ~trail_seq ~ts ~user ~role ~tool:e.tool ~args_hash:e.args_hash
               ~result_hash:e.result_hash ~status:e.status ~engagement_id:e.engagement_id)
      in
      match
        Eio_unix.run_in_systhread (fun () ->
            try
              Db.transaction t.db (fun () ->
                  ignore
                    (Db.exec t.db
                       ~params:
                         [|
                           string_of_int trail_seq;
                           ts;
                           user;
                           role;
                           e.tool;
                           e.args_hash;
                           e.result_hash;
                           e.status;
                           Db.opt e.engagement_id;
                           prev_hash;
                           hash;
                         |]
                       "INSERT INTO trail.entries (trail_seq, ts, identity_user, identity_role, tool, \
                        args_hash, result_hash, status, engagement_id, prev_hash, hash) VALUES ($1, \
                        $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11)"));
              Ok ()
            with Db.Db_error msg -> Error msg)
      with
      | Error msg -> Error.fail Error.Internal "The trail entry could not be stored: %s" msg
      | Ok () ->
          t.head_seq <- trail_seq;
          t.head_hash <- hash;
          Ok (trail_seq, hash))

let head (t : t) : int * string =
  Sequencer.submit t.sequencer (fun () -> (t.head_seq, t.head_hash))

let verification_rows (db : Db.t) ~(first : int) ~(last : int) : Verify.row list =
  let r =
    Db.exec db
      ~params:[| string_of_int first; string_of_int last |]
      "SELECT trail_seq, prev_hash, hash, \
       to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), identity_user, \
       identity_role, tool, args_hash, result_hash, status, engagement_id FROM trail.entries WHERE \
       trail_seq BETWEEN $1 AND $2 ORDER BY trail_seq"
  in
  List.init (Db.rows r) (fun i ->
      let trail_seq = Db.get_int r i 0 in
      let c =
        content ~trail_seq ~ts:(Db.get r i 3) ~user:(Db.get r i 4) ~role:(Db.get r i 5)
          ~tool:(Db.get r i 6) ~args_hash:(Db.get r i 7) ~result_hash:(Db.get r i 8)
          ~status:(Db.get r i 9) ~engagement_id:(Db.get_opt r i 10)
      in
      {
        Verify.seq = trail_seq;
        prev_hash = Db.get r i 1;
        hash = Db.get r i 2;
        canonical = Canonical.to_string c;
        balanced = true;
      })

let source : Verify.source =
  {
    Verify.name = "trail";
    max_seq =
      (fun db -> Db.get_int (Db.exec db "SELECT coalesce(max(trail_seq), 0) FROM trail.entries") 0 0);
    hash_at =
      (fun db seq ->
        let r =
          Db.exec db ~params:[| string_of_int seq |]
            "SELECT hash FROM trail.entries WHERE trail_seq = $1"
        in
        if Db.rows r = 0 then None else Some (Db.get r 0 0));
    rows = verification_rows;
  }
