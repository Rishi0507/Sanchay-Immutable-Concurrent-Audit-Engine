(* HTTP API of the ledger core. See contracts/ledger-api.md. *)

type t = {
  business : Business_chain.t;
  trail : Trail_chain.t;
  conninfo : string;
  service_token : string;
  domains : int;
}

let json_headers = Http.Header.of_list [ ("content-type", "application/json") ]

let respond ?(status = 200) (j : Yojson.Safe.t) =
  Cohttp_eio.Server.respond_string ~headers:json_headers ~status:(Http.Status.of_int status)
    ~body:(Yojson.Safe.to_string j) ()

let respond_error (e : Error.t) = respond ~status:(Error.http_status e.Error.code) (Error.to_json e)

let fail code message = respond_error (Error.make code message)

let read_json body : (Yojson.Safe.t, Error.t) result =
  let text = Eio.Buf_read.(parse_exn take_all) body ~max_size:(64 * 1024 * 1024) in
  match Yojson.Safe.from_string text with
  | j -> Ok j
  | exception _ -> Error.fail Error.Validation_failed "The request body is not valid JSON."

let query_int uri name =
  match Uri.get_query_param uri name with
  | None | Some "" -> Ok None
  | Some s -> (
      match int_of_string_opt s with
      | Some n when n >= 0 -> Ok (Some n)
      | _ -> Error.fail Error.Validation_failed "%s must be a whole number." name)

let append (t : t) body =
  let ( let* ) = Result.bind in
  let result =
    let* json = read_json body in
    let* request, identity = Business_chain.parse_request json in
    (* The capability is obtained here and nowhere else. An auditor identity
       stops at this line. *)
    let* cap = Capability.client_of_identity identity in
    Business_chain.append t.business cap request
  in
  match result with
  | Error e -> respond_error e
  | Ok r ->
      respond
        (`Assoc
           [
             ("seq", `Int r.Business_chain.seq);
             ("hash", `String r.Business_chain.hash);
             ("aggregate_version", `Int r.Business_chain.aggregate_version);
             ("duplicate", `Bool r.Business_chain.duplicate);
           ])

let head (t : t) =
  let seq, hash = Business_chain.head t.business in
  respond (`Assoc [ ("seq", `Int seq); ("hash", `String hash) ])

let verify (t : t) (source : Verify.source) uri =
  let ( let* ) = Result.bind in
  let params =
    let* from = query_int uri "from" in
    let* to_ = query_int uri "to" in
    let* at = query_int uri "at" in
    Ok (from, to_, at)
  in
  match params with
  | Error e -> respond_error e
  | Ok (from, to_, at) -> (
      match
        Eio_unix.run_in_systhread (fun () ->
            try
              Ok
                (Verify.run ~domains:t.domains source t.conninfo
                   ?from:(Option.map (max 1) from)
                   ?to_ ?at ())
            with
            | Db.Db_error msg -> Error msg
            | e -> Error (Printexc.to_string e))
      with
      | Ok outcome -> respond (Verify.to_json outcome)
      | Error msg -> fail Error.Internal ("Verification could not run: " ^ msg))

let merkle (t : t) day =
  match Business_chain.merkle_root t.business day with
  | Error e -> respond_error e
  | Ok m ->
      respond
        (`Assoc
           [
             ("date", `String m.Business_chain.day);
             ("root", `String m.Business_chain.root);
             ("first_seq", `Int m.Business_chain.first_seq);
             ("last_seq", `Int m.Business_chain.last_seq);
             ("count", `Int m.Business_chain.count);
           ])

let proof (t : t) seq_text =
  match int_of_string_opt seq_text with
  | None -> fail Error.Validation_failed "The sequence number must be a whole number."
  | Some seq -> (
      match Business_chain.merkle_proof t.business seq with
      | Error e -> respond_error e
      | Ok p ->
          let path =
            List.map
              (fun (side, hash) ->
                `Assoc
                  [
                    ( "side",
                      `String (match side with Hash.Merkle.Left -> "left" | Hash.Merkle.Right -> "right") );
                    ("hash", `String hash);
                  ])
              p.Business_chain.p_path
          in
          respond
            (`Assoc
               [
                 ("seq", `Int p.Business_chain.p_seq);
                 ("hash", `String p.Business_chain.p_hash);
                 ("date", `String p.Business_chain.p_day);
                 ("root", `String p.Business_chain.p_root);
                 ("path", `List path);
               ]))

let trail_append (t : t) body =
  let ( let* ) = Result.bind in
  let result =
    let* json = read_json body in
    let* entry = Trail_chain.parse json in
    Trail_chain.append t.trail entry
  in
  match result with
  | Error e -> respond_error e
  | Ok (trail_seq, hash) -> respond (`Assoc [ ("trail_seq", `Int trail_seq); ("hash", `String hash) ])

let health (t : t) =
  let head_seq, _ = Business_chain.head t.business in
  let trail_seq, _ = Trail_chain.head t.trail in
  respond
    (`Assoc [ ("status", `String "ok"); ("head_seq", `Int head_seq); ("trail_seq", `Int trail_seq) ])

let authorised (t : t) request =
  t.service_token = ""
  ||
  match Http.Header.get (Http.Request.headers request) "x-service-token" with
  | Some token -> String.equal token t.service_token
  | None -> false

let handler (t : t) _conn (request : Http.Request.t) body =
  let uri = Uri.of_string (Http.Request.resource request) in
  let segments = String.split_on_char '/' (Uri.path uri) |> List.filter (fun s -> s <> "") in
  try
    match (Http.Request.meth request, segments) with
    | `GET, [ "health" ] -> health t
    | _ when not (authorised t request) ->
        fail Error.Not_permitted "The service token is missing or wrong."
    | `POST, [ "append" ] -> append t body
    | `GET, [ "head" ] -> head t
    | `GET, [ "verify" ] -> verify t Business_chain.source uri
    | `GET, [ "merkle"; day ] -> merkle t day
    | `GET, [ "proof"; seq ] -> proof t seq
    | `POST, [ "trail"; "append" ] -> trail_append t body
    | `GET, [ "trail"; "verify" ] -> verify t Trail_chain.source uri
    | _ -> fail Error.Not_found "No such endpoint."
  with e -> fail Error.Internal (Printexc.to_string e)
