(* The parts of contracts/events.json the ledger core needs: how each event
   treats its aggregate, and which payload fields refer to other aggregates.
   Reading them from the shared contract keeps the core and the MCP server on
   one definition. *)

type mode = Create | Update | Reverse

type reference = { field : string; target : string; is_list : bool }

type spec = {
  kind : Event_kind.t;
  aggregate : string;
  mode : mode;
  posts : bool;
  references : reference list;
}

type t = (Event_kind.t * spec) list

let member name (j : Yojson.Safe.t) =
  match j with `Assoc fields -> List.assoc_opt name fields | _ -> None

let string_member name j = match member name j with Some (`String s) -> Some s | _ -> None

let parse_event (j : Yojson.Safe.t) : (spec, string) result =
  match string_member "type" j with
  | None -> Error "an event has no type"
  | Some type_name -> (
      match Event_kind.of_string type_name with
      | None -> Error (Printf.sprintf "event type %s is not known to the ledger core" type_name)
      | Some kind -> (
          let mode =
            match string_member "mode" j with
            | Some "create" -> Ok Create
            | Some "update" -> Ok Update
            | Some "reverse" -> Ok Reverse
            | _ -> Error (Printf.sprintf "event %s has no valid mode" type_name)
          in
          match mode with
          | Error e -> Error e
          | Ok mode ->
              let aggregate = Option.value (string_member "aggregate" j) ~default:"" in
              let posts = match member "posts" j with Some (`Bool b) -> b | _ -> false in
              let references =
                match member "fields" j with
                | Some (`List fields) ->
                    List.filter_map
                      (fun f ->
                        match (string_member "name" f, string_member "type" f, string_member "ref" f) with
                        | Some field, Some "ref", Some target -> Some { field; target; is_list = false }
                        | Some field, Some "ref_list", Some target ->
                            Some { field; target; is_list = true }
                        | _ -> None)
                      fields
                | _ -> []
              in
              Ok { kind; aggregate; mode; posts; references }))

(* Loads the catalogue and checks it against the code: every kind has exactly
   one entry, and the posting flag agrees with [Posting_rules.posts]. *)
let load (path : string) : (t, string) result =
  match Yojson.Safe.from_file path with
  | exception e -> Error (Printf.sprintf "cannot read %s: %s" path (Printexc.to_string e))
  | json -> (
      match member "events" json with
      | Some (`List events) -> (
          let rec collect acc = function
            | [] -> Ok (List.rev acc)
            | e :: rest -> (
                match parse_event e with
                | Ok spec -> collect ((spec.kind, spec) :: acc) rest
                | Error msg -> Error msg)
          in
          match collect [] events with
          | Error msg -> Error msg
          | Ok specs ->
              let problems =
                List.filter_map
                  (fun kind ->
                    match List.assoc_opt kind specs with
                    | None ->
                        Some (Printf.sprintf "%s is missing from the catalogue" (Event_kind.to_string kind))
                    | Some spec when spec.posts <> Posting_rules.posts kind ->
                        Some
                          (Printf.sprintf "%s: the catalogue and the posting rules disagree on whether it posts"
                             (Event_kind.to_string kind))
                    | Some _ -> None)
                  Event_kind.all
              in
              if problems = [] then Ok specs else Error (String.concat "; " problems))
      | _ -> Error (Printf.sprintf "%s has no events list" path))

let find (t : t) (kind : Event_kind.t) : spec = List.assoc kind t

(* The identifiers a payload refers to, each with the aggregate type the
   catalogue expects. *)
let referenced (spec : spec) (payload : Yojson.Safe.t) : (string * string * string) list =
  List.concat_map
    (fun r ->
      match member r.field payload with
      | Some (`String id) when id <> "" -> [ (r.field, r.target, id) ]
      | Some (`List items) when r.is_list ->
          List.filter_map
            (function `String id when id <> "" -> Some (r.field, r.target, id) | _ -> None)
            items
      | _ -> [])
    spec.references
