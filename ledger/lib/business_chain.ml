(* The business chain: the event log and its ledger postings.

   All functions that touch the head run on the chain's sequencer fiber. The
   state held in memory (head, aggregate versions, idempotency keys) is
   rebuilt from the database at start-up and changed only after a commit. *)

open Error

type aggregate = {
  atype : string;
  entity_id : string;
  created_seq : int;
  posted : bool;
  mutable version : int;
  mutable reversed : bool;
}

type receipt = { seq : int; hash : string; aggregate_version : int; duplicate : bool }

type idempotent = { request_hash : string; stored : receipt }

type t = {
  db : Db.t;
  catalogue : Catalogue.t;
  sequencer : Sequencer.t;
  mutable head_seq : int;
  mutable head_hash : string;
  aggregates : (string, aggregate) Hashtbl.t;
  idempotency : (string, idempotent) Hashtbl.t;
}

type request = {
  event_type : string;
  entity_id : string;
  aggregate_type : string;
  aggregate_id : string;
  expected_version : int;
  sale_id : string option;
  payload : Yojson.Safe.t;
  business_date : string option;
  idempotency_key : string;
  request_hash : string;
}

(* --------------------------------------------------------------------- *)
(* Request parsing *)

let member name (j : Yojson.Safe.t) =
  match j with `Assoc fields -> List.assoc_opt name fields | _ -> None

let required_string j name =
  match member name j with
  | Some (`String s) when s <> "" -> Ok s
  | _ -> Error.fail Error.Validation_failed "%s is required." name

let optional_string j name =
  match member name j with
  | Some (`String s) when s <> "" -> Ok (Some s)
  | None | Some `Null | Some (`String _) -> Ok None
  | Some _ -> Error.fail Error.Validation_failed "%s must be a string or null." name

(* jsonb keeps one value per key and has no NaN or infinity. A payload that
   relies on either would not hash the same after it is stored, so it is
   refused. *)
let rec check_storable path (j : Yojson.Safe.t) : (unit, Error.t) result =
  match j with
  | `Assoc fields ->
      let keys = List.map fst fields in
      let sorted = List.sort String.compare keys in
      let rec has_dup = function
        | a :: (b :: _ as rest) -> String.equal a b || has_dup rest
        | _ -> false
      in
      if has_dup sorted then
        Error.fail Error.Validation_failed "payload%s repeats a key." path
      else
        List.fold_left
          (fun acc (k, v) ->
            let* () = acc in
            check_storable (path ^ "." ^ k) v)
          (Ok ()) fields
  | `List items ->
      List.fold_left
        (fun acc v ->
          let* () = acc in
          check_storable (path ^ "[]") v)
        (Ok ()) items
  | `Float f when Float.is_nan f || Float.abs f = Float.infinity ->
      Error.fail Error.Validation_failed "payload%s is not a finite number." path
  | `Null | `Bool _ | `Int _ | `Intlit _ | `Float _ | `String _ -> Ok ()

let parse_request (body : Yojson.Safe.t) : (request * Identity.t, Error.t) result =
  let* event_type = required_string body "event_type" in
  let* entity_id = required_string body "entity_id" in
  let* aggregate_type = required_string body "aggregate_type" in
  let* aggregate_id = required_string body "aggregate_id" in
  let* idempotency_key = required_string body "idempotency_key" in
  let* sale_id = optional_string body "sale_id" in
  let* business_date = optional_string body "business_date" in
  let* () =
    match business_date with
    | Some d when not (Clock.is_date d) ->
        Error.fail Error.Validation_failed "business_date must be in the form YYYY-MM-DD."
    | _ -> Ok ()
  in
  let* expected_version =
    match member "expected_version" body with
    | Some (`Int n) when n >= 0 -> Ok n
    | None | Some `Null -> Ok 0
    | Some _ -> Error.fail Error.Validation_failed "expected_version must be a whole number."
  in
  let* payload =
    match member "payload" body with
    | Some (`Assoc _ as p) -> Ok p
    | _ -> Error.fail Error.Validation_failed "payload must be an object."
  in
  let* () = check_storable "" payload in
  let* identity =
    match member "identity" body with
    | Some j -> Identity.of_json j
    | None -> Error.fail Error.Validation_failed "identity is required."
  in
  let request_hash = Hash.sha256 (Canonical.to_string body) in
  Ok
    ( {
        event_type;
        entity_id;
        aggregate_type;
        aggregate_id;
        expected_version;
        sale_id;
        payload;
        business_date;
        idempotency_key;
        request_hash;
      },
      identity )

(* --------------------------------------------------------------------- *)
(* Hashed content *)

let content ~seq ~(req : request) ~aggregate_version ~recorded_at ~(identity : Identity.t)
    ~(postings : Yojson.Safe.t) : Yojson.Safe.t =
  let opt = function Some s -> `String s | None -> `Null in
  `Assoc
    [
      ("aggregate_id", `String req.aggregate_id);
      ("aggregate_type", `String req.aggregate_type);
      ("aggregate_version", `Int aggregate_version);
      ("business_date", opt req.business_date);
      ("entity_id", `String req.entity_id);
      ("event_type", `String req.event_type);
      ("idempotency_key", `String req.idempotency_key);
      ("identity", Identity.to_json identity);
      ("payload", req.payload);
      ("postings", postings);
      ("recorded_at", `String recorded_at);
      ("sale_id", opt req.sale_id);
      ("seq", `Int seq);
    ]

(* --------------------------------------------------------------------- *)
(* Start-up *)

let load_state (t : t) : unit =
  let r =
    Db.exec t.db
      "SELECT e.seq, e.event_type, e.aggregate_type, e.aggregate_id, e.aggregate_version, \
       e.entity_id, e.idempotency_key, e.request_hash, e.hash, \
       EXISTS (SELECT 1 FROM business.postings p WHERE p.seq = e.seq) \
       FROM business.events e ORDER BY e.seq"
  in
  for i = 0 to Db.rows r - 1 do
    let seq = Db.get_int r i 0 in
    let event_type = Db.get r i 1 in
    let atype = Db.get r i 2 in
    let id = Db.get r i 3 in
    let version = Db.get_int r i 4 in
    let entity_id = Db.get r i 5 in
    let key = Db.get r i 6 in
    let request_hash = Db.get r i 7 in
    let hash = Db.get r i 8 in
    let posted = String.equal (Db.get r i 9) "t" in
    (match Hashtbl.find_opt t.aggregates id with
    | None ->
        Hashtbl.replace t.aggregates id
          { atype; entity_id; created_seq = seq; posted; version; reversed = false }
    | Some a ->
        a.version <- version;
        if String.equal event_type "DocumentReversed" then a.reversed <- true);
    Hashtbl.replace t.idempotency key
      { request_hash; stored = { seq; hash; aggregate_version = version; duplicate = true } };
    t.head_seq <- seq;
    t.head_hash <- hash
  done

let create ~sw ~conninfo ~catalogue : t =
  let t =
    {
      db = Db.connect conninfo;
      catalogue;
      sequencer = Sequencer.create ~sw ();
      head_seq = 0;
      head_hash = Hash.genesis;
      aggregates = Hashtbl.create 4096;
      idempotency = Hashtbl.create 4096;
    }
  in
  load_state t;
  t

(* --------------------------------------------------------------------- *)
(* Append *)

let target_posting (t : t) (a : aggregate) : (Posting.t option, Error.t) result =
  if not a.posted then Ok None
  else
    let r =
      Db.exec t.db
        ~params:[| string_of_int a.created_seq |]
        "SELECT account_code, debit, credit FROM business.postings WHERE seq = $1 ORDER BY line_no"
    in
    let lines =
      List.init (Db.rows r) (fun i ->
          match Account.of_code (Db.get r i 0) with
          | None -> None
          | Some account ->
              let d = Db.get_int r i 1 and c = Db.get_int r i 2 in
              if d > 0 then Posting.debit account d else Posting.credit account c)
    in
    let* p = Posting.make lines in
    Ok (Some p)

(* Structural validation (PRD section 6.4). Commercially unusual events are
   accepted on purpose: they are what the audit must find. *)
let validate (t : t) (kind : Event_kind.t) (spec : Catalogue.spec) (req : request) :
    (int * Posting.t option, Error.t) result =
  let existing = Hashtbl.find_opt t.aggregates req.aggregate_id in
  let* version, target =
    match (spec.Catalogue.mode, existing) with
    | Catalogue.Create, Some _ ->
        Error.fail Error.Version_conflict "%s already exists." req.aggregate_id
    | Catalogue.Create, None ->
        if req.expected_version <> 0 then
          Error.fail Error.Version_conflict
            "expected_version must be 0 when a record is created."
        else if not (String.equal req.aggregate_type spec.Catalogue.aggregate) then
          Error.fail Error.Validation_failed "%s creates a %s, not a %s." req.event_type
            spec.Catalogue.aggregate req.aggregate_type
        else Ok (1, None)
    | (Catalogue.Update | Catalogue.Reverse), None ->
        Error.fail Error.Unknown_reference "%s does not exist." req.aggregate_id
    | (Catalogue.Update | Catalogue.Reverse), Some a ->
        if a.reversed then
          Error.fail Error.Invalid_transition "%s is already reversed." req.aggregate_id
        else if req.expected_version <> a.version then
          Error.fail Error.Version_conflict "%s is at version %d, not %d." req.aggregate_id
            a.version req.expected_version
        else if not (String.equal req.aggregate_type a.atype) then
          Error.fail Error.Validation_failed "%s is a %s, not a %s." req.aggregate_id a.atype
            req.aggregate_type
        else if not (String.equal req.entity_id a.entity_id) then
          Error.fail Error.Validation_failed "%s belongs to entity %s." req.aggregate_id
            a.entity_id
        else if spec.Catalogue.mode = Catalogue.Update
                && not (String.equal a.atype spec.Catalogue.aggregate)
        then
          Error.fail Error.Validation_failed "%s applies to a %s, not a %s." req.event_type
            spec.Catalogue.aggregate a.atype
        else if spec.Catalogue.mode = Catalogue.Reverse then
          let* target = target_posting t a in
          Ok (a.version + 1, target)
        else Ok (a.version + 1, None)
  in
  let* () =
    List.fold_left
      (fun acc (field, expected, id) ->
        let* () = acc in
        match Hashtbl.find_opt t.aggregates id with
        | None -> Error.fail Error.Unknown_reference "%s refers to %s, which does not exist." field id
        | Some a when not (String.equal a.atype expected) ->
            Error.fail Error.Unknown_reference "%s refers to %s, which is a %s, not a %s." field
              id a.atype expected
        | Some _ -> Ok ())
      (Ok ())
      (Catalogue.referenced spec req.payload)
  in
  ignore kind;
  Ok (version, target)

let insert (t : t) ~seq ~(req : request) ~version ~recorded_at ~(identity : Identity.t) ~prev_hash
    ~hash ~(posting : Posting.t) : unit =
  Db.transaction t.db (fun () ->
      ignore
        (Db.exec t.db
           ~params:
             [|
               string_of_int seq;
               req.event_type;
               req.entity_id;
               req.aggregate_type;
               req.aggregate_id;
               string_of_int version;
               Db.opt req.sale_id;
               Yojson.Safe.to_string req.payload;
               Db.opt req.business_date;
               recorded_at;
               identity.Identity.user;
               Identity.role_string identity.Identity.role;
               req.idempotency_key;
               req.request_hash;
               prev_hash;
               hash;
             |]
           "INSERT INTO business.events (seq, event_type, entity_id, aggregate_type, aggregate_id, \
            aggregate_version, sale_id, payload, business_date, recorded_at, identity_user, \
            identity_role, idempotency_key, request_hash, prev_hash, hash) VALUES ($1, $2, $3, $4, \
            $5, $6, $7, $8::jsonb, $9::date, $10::timestamptz, $11, $12, $13, $14, $15, $16)");
      List.iteri
        (fun i (line : Posting.line) ->
          ignore
            (Db.exec t.db
               ~params:
                 [|
                   string_of_int seq;
                   string_of_int (i + 1);
                   Account.code line.Posting.account;
                   string_of_int line.Posting.debit;
                   string_of_int line.Posting.credit;
                   req.entity_id;
                   Db.opt req.sale_id;
                   req.event_type;
                   Db.opt req.business_date;
                 |]
               "INSERT INTO business.postings (seq, line_no, account_code, debit, credit, entity_id, \
                sale_id, source_event_type, business_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, \
                $9::date)"))
        (Posting.lines posting))

(* Runs on the sequencer fiber. *)
let append_locked (t : t) (identity : Identity.t) (req : request) : (receipt, Error.t) result =
  match Hashtbl.find_opt t.idempotency req.idempotency_key with
  | Some seen ->
      if String.equal seen.request_hash req.request_hash then Ok seen.stored
      else
        Error.fail Error.Idempotency_mismatch
          "idempotency_key %s was already used for a different request." req.idempotency_key
  | None -> (
      match Event_kind.of_string req.event_type with
      | None -> Error.fail Error.Validation_failed "%s is not a known event type." req.event_type
      | Some kind -> (
          let spec = Catalogue.find t.catalogue kind in
          let* version, target =
            Eio_unix.run_in_systhread (fun () ->
                try validate t kind spec req
                with Db.Db_error msg -> Error.fail Error.Internal "database: %s" msg)
          in
          let* posting = Posting_rules.derive kind req.payload ~target in
          let seq = t.head_seq + 1 in
          let prev_hash = t.head_hash in
          let recorded_at = Clock.now_utc () in
          let content =
            content ~seq ~req ~aggregate_version:version ~recorded_at ~identity
              ~postings:(Posting.to_json posting)
          in
          let hash = Hash.chain ~prev_hash ~content in
          match
            Eio_unix.run_in_systhread (fun () ->
                try
                  insert t ~seq ~req ~version ~recorded_at ~identity ~prev_hash ~hash ~posting;
                  Ok ()
                with Db.Db_error msg -> Error msg)
          with
          | Error msg ->
              (* Nothing was committed and the in-memory state is unchanged. *)
              Error.fail Error.Validation_failed "The event could not be stored: %s" msg
          | Ok () ->
              t.head_seq <- seq;
              t.head_hash <- hash;
              (match Hashtbl.find_opt t.aggregates req.aggregate_id with
              | None ->
                  Hashtbl.replace t.aggregates req.aggregate_id
                    {
                      atype = req.aggregate_type;
                      entity_id = req.entity_id;
                      created_seq = seq;
                      posted = not (Posting.is_empty posting);
                      version;
                      reversed = false;
                    }
              | Some a ->
                  a.version <- version;
                  if kind = Event_kind.Document_reversed then a.reversed <- true);
              let receipt = { seq; hash; aggregate_version = version; duplicate = false } in
              Hashtbl.replace t.idempotency req.idempotency_key
                { request_hash = req.request_hash; stored = { receipt with duplicate = true } };
              Ok receipt))

(* The only entry point for writing. It demands a client capability, which an
   auditor identity cannot obtain (LC-3). *)
let append (t : t) (cap : Capability.client) (req : request) : (receipt, Error.t) result =
  let identity = Capability.identity_of_client cap in
  Sequencer.submit t.sequencer (fun () -> append_locked t identity req)

let head (t : t) : int * string =
  Sequencer.submit t.sequencer (fun () -> (t.head_seq, t.head_hash))

(* --------------------------------------------------------------------- *)
(* Merkle roots (LC-7) *)

let day_leaves (db : Db.t) (day : string) : (int * string) list =
  let r =
    Db.exec db ~params:[| day |]
      "SELECT seq, hash FROM business.events WHERE (recorded_at AT TIME ZONE 'UTC')::date = \
       $1::date ORDER BY seq"
  in
  List.init (Db.rows r) (fun i -> (Db.get_int r i 0, Db.get r i 1))

type merkle = { day : string; root : string; first_seq : int; last_seq : int; count : int }

(* Computes the root of a day and stores it. Runs on the sequencer fiber so
   that the write connection is never used by two operations at once. *)
let merkle_root (t : t) (day : string) : (merkle, Error.t) result =
  if not (Clock.is_date day) then
    Error.fail Error.Validation_failed "The date must be in the form YYYY-MM-DD."
  else
    Sequencer.submit t.sequencer (fun () ->
        Eio_unix.run_in_systhread (fun () ->
            try
              Db.ensure t.db;
              let leaves = day_leaves t.db day in
              match Hash.Merkle.root (List.map snd leaves) with
              | None -> Error.fail Error.Not_found "No events were recorded on %s." day
              | Some root ->
                  let first_seq = fst (List.hd leaves) in
                  let last_seq = fst (List.nth leaves (List.length leaves - 1)) in
                  ignore
                    (Db.exec t.db
                       ~params:[| day; string_of_int first_seq; string_of_int last_seq; root |]
                       "INSERT INTO business.merkle_roots (day, first_seq, last_seq, root) VALUES \
                        ($1::date, $2, $3, $4) ON CONFLICT (day, last_seq) DO NOTHING");
                  Ok { day; root; first_seq; last_seq; count = List.length leaves }
            with Db.Db_error msg -> Error.fail Error.Internal "database: %s" msg))

type proof = {
  p_seq : int;
  p_hash : string;
  p_day : string;
  p_root : string;
  p_path : (Hash.Merkle.side * string) list;
}

let merkle_proof (t : t) (seq : int) : (proof, Error.t) result =
  Sequencer.submit t.sequencer (fun () ->
      Eio_unix.run_in_systhread (fun () ->
          try
            Db.ensure t.db;
            let r =
              Db.exec t.db
                ~params:[| string_of_int seq |]
                "SELECT hash, (recorded_at AT TIME ZONE 'UTC')::date::text FROM business.events \
                 WHERE seq = $1"
            in
            if Db.rows r = 0 then Error.fail Error.Not_found "There is no event with seq %d." seq
            else
              let hash = Db.get r 0 0 and day = Db.get r 0 1 in
              let leaves = day_leaves t.db day in
              let rec index_of i = function
                | [] -> None
                | (s, _) :: rest -> if s = seq then Some i else index_of (i + 1) rest
              in
              let hashes = List.map snd leaves in
              match (index_of 0 leaves, Hash.Merkle.root hashes) with
              | Some index, Some root -> (
                  match Hash.Merkle.proof hashes index with
                  | Some path -> Ok { p_seq = seq; p_hash = hash; p_day = day; p_root = root; p_path = path }
                  | None -> Error.fail Error.Internal "The proof could not be built.")
              | _ -> Error.fail Error.Internal "The event is missing from its day."
          with Db.Db_error msg -> Error.fail Error.Internal "database: %s" msg))

(* --------------------------------------------------------------------- *)
(* Verification rows *)

(* Rebuilds the hashed content of stored events from the database alone, so
   verification does not trust anything held in memory. *)
let verification_rows (db : Db.t) ~(first : int) ~(last : int) : Verify.row list =
  let r =
    Db.exec db
      ~params:[| string_of_int first; string_of_int last |]
      "SELECT e.seq, e.prev_hash, e.hash, e.event_type, e.entity_id, e.aggregate_type, \
       e.aggregate_id, e.aggregate_version, e.sale_id, e.payload::text, e.business_date::text, \
       to_char(e.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
       e.identity_user, e.identity_role, e.idempotency_key, \
       coalesce((SELECT json_agg(json_build_object('account', p.account_code, 'credit', p.credit, \
       'debit', p.debit) ORDER BY p.line_no) FROM business.postings p WHERE p.seq = e.seq)::text, \
       '[]'), \
       coalesce((SELECT sum(p.debit) - sum(p.credit) FROM business.postings p WHERE p.seq = e.seq), \
       0) \
       FROM business.events e WHERE e.seq BETWEEN $1 AND $2 ORDER BY e.seq"
  in
  List.init (Db.rows r) (fun i ->
      let opt j = match Db.get_opt r i j with Some s -> `String s | None -> `Null in
      let seq = Db.get_int r i 0 in
      let content : Yojson.Safe.t =
        `Assoc
          [
            ("aggregate_id", `String (Db.get r i 6));
            ("aggregate_type", `String (Db.get r i 5));
            ("aggregate_version", `Int (Db.get_int r i 7));
            ("business_date", opt 10);
            ("entity_id", `String (Db.get r i 4));
            ("event_type", `String (Db.get r i 3));
            ("idempotency_key", `String (Db.get r i 14));
            ( "identity",
              `Assoc [ ("role", `String (Db.get r i 13)); ("user", `String (Db.get r i 12)) ] );
            ("payload", Yojson.Safe.from_string (Db.get r i 9));
            ("postings", Yojson.Safe.from_string (Db.get r i 15));
            ("recorded_at", `String (Db.get r i 11));
            ("sale_id", opt 8);
            ("seq", `Int seq);
          ]
      in
      {
        Verify.seq;
        prev_hash = Db.get r i 1;
        hash = Db.get r i 2;
        canonical = Canonical.to_string content;
        balanced = String.equal (Db.get r i 16) "0";
      })

let source : Verify.source =
  {
    Verify.name = "business";
    max_seq = (fun db -> Db.get_int (Db.exec db "SELECT coalesce(max(seq), 0) FROM business.events") 0 0);
    hash_at =
      (fun db seq ->
        let r =
          Db.exec db ~params:[| string_of_int seq |] "SELECT hash FROM business.events WHERE seq = $1"
        in
        if Db.rows r = 0 then None else Some (Db.get r 0 0));
    rows = verification_rows;
  }
