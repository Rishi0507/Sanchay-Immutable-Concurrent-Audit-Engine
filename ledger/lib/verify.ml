(* Chain verification (LC-8).

   The chain is cut into segments and each segment is verified in its own
   domain, on its own database connection. A segment trusts only the stored
   hash of the event just before it, and that event is verified by the
   segment before, so the segments together cover the whole chain. Nothing
   held in memory by the sequencer is consulted. *)

type row = {
  seq : int;
  prev_hash : string;
  hash : string;
  canonical : string;
  balanced : bool;
}

(* How to read one chain. The business chain and the trail chain each supply
   one of these. *)
type source = {
  name : string;
  max_seq : Db.t -> int;
  hash_at : Db.t -> int -> string option;
  rows : Db.t -> first:int -> last:int -> row list;
}

type failure = { bad_seq : int; reason : string }

type outcome = {
  ok : bool;
  checked : int;
  failure : failure option;
  head_seq : int;
  head_hash : string;
  at : (int * string) option;
  segments : int;
}

let batch = 2000
let min_rows_per_domain = 500

let verify_segment (source : source) (conninfo : string) ~(first : int) ~(last : int) :
    int * failure option =
  let db = Db.connect conninfo in
  Fun.protect
    ~finally:(fun () -> Db.close db)
    (fun () ->
      let start_prev = if first = 1 then Some Hash.genesis else source.hash_at db (first - 1) in
      match start_prev with
      | None -> (0, Some { bad_seq = first - 1; reason = "sequence_gap" })
      | Some start_prev ->
          let rec walk expected_seq expected_prev checked =
            if expected_seq > last then (checked, None)
            else
              let upto = min last (expected_seq + batch - 1) in
              let rows = source.rows db ~first:expected_seq ~last:upto in
              let rec check expected_seq expected_prev checked = function
                | [] -> Ok (expected_seq, expected_prev, checked)
                | (r : row) :: rest ->
                    if r.seq <> expected_seq then
                      Error (checked, { bad_seq = expected_seq; reason = "sequence_gap" })
                    else if not (String.equal r.prev_hash expected_prev) then
                      Error (checked, { bad_seq = r.seq; reason = "prev_hash_mismatch" })
                    else if not r.balanced then
                      Error (checked, { bad_seq = r.seq; reason = "postings_mismatch" })
                    else if
                      not
                        (String.equal r.hash
                           (Hash.chain_raw ~prev_hash:r.prev_hash ~canonical:r.canonical))
                    then Error (checked, { bad_seq = r.seq; reason = "hash_mismatch" })
                    else check (expected_seq + 1) r.hash (checked + 1) rest
              in
              match check expected_seq expected_prev checked rows with
              | Error (checked, failure) -> (checked, Some failure)
              | Ok (next_seq, next_prev, checked) ->
                  if next_seq <= upto then
                    (checked, Some { bad_seq = next_seq; reason = "sequence_gap" })
                  else walk next_seq next_prev checked
          in
          walk first start_prev 0)

(* One verification at a time, so a burst of requests cannot exhaust the
   domain limit. *)
let gate = Mutex.create ()

(* Blocking. Call it from a system thread. *)
let run ~(domains : int) (source : source) (conninfo : string) ?(from = 1) ?to_ ?at () : outcome =
  Mutex.protect gate (fun () ->
      let db = Db.connect conninfo in
      let head_seq, head_hash, at =
        Fun.protect
          ~finally:(fun () -> Db.close db)
          (fun () ->
            let head_seq = source.max_seq db in
            let head_hash =
              if head_seq = 0 then Hash.genesis
              else Option.value (source.hash_at db head_seq) ~default:""
            in
            let at =
              match at with
              | Some seq when seq >= 1 && seq <= head_seq ->
                  Option.map (fun h -> (seq, h)) (source.hash_at db seq)
              | Some 0 -> Some (0, Hash.genesis)
              | _ -> None
            in
            (head_seq, head_hash, at))
      in
      let first = max 1 from in
      let last = match to_ with Some t -> min t head_seq | None -> head_seq in
      if last < first then
        { ok = true; checked = 0; failure = None; head_seq; head_hash; at; segments = 0 }
      else
        let n = last - first + 1 in
        let k = max 1 (min domains ((n + min_rows_per_domain - 1) / min_rows_per_domain)) in
        let size = (n + k - 1) / k in
        let bounds =
          List.init k (fun i -> (first + (i * size), min last (first + ((i + 1) * size) - 1)))
          |> List.filter (fun (a, b) -> a <= b)
        in
        let workers =
          List.map
            (fun (a, b) ->
              Domain.spawn (fun () ->
                  try Ok (verify_segment source conninfo ~first:a ~last:b)
                  with e -> Error (a, Printexc.to_string e)))
            bounds
        in
        let results = List.map Domain.join workers in
        let checked, failure =
          List.fold_left
            (fun (checked, failure) result ->
              let c, f =
                match result with
                | Ok (c, f) -> (c, f)
                | Error (a, msg) -> (0, Some { bad_seq = a; reason = "verification_error: " ^ msg })
              in
              let failure =
                match (failure, f) with
                | None, f -> f
                | Some x, Some y when y.bad_seq < x.bad_seq -> Some y
                | Some x, _ -> Some x
              in
              (checked + c, failure))
            (0, None) results
        in
        {
          ok = failure = None;
          checked;
          failure;
          head_seq;
          head_hash;
          at;
          segments = List.length bounds;
        })

let to_json (o : outcome) : Yojson.Safe.t =
  let first_bad, reason =
    match o.failure with
    | Some f -> (`Int f.bad_seq, `String f.reason)
    | None -> (`Null, `Null)
  in
  let base =
    [
      ("ok", `Bool o.ok);
      ("checked", `Int o.checked);
      ("first_bad_seq", first_bad);
      ("reason", reason);
      ("head_seq", `Int o.head_seq);
      ("head_hash", `String o.head_hash);
      ("segments", `Int o.segments);
    ]
  in
  let at =
    match o.at with
    | Some (seq, hash) -> [ ("at", `Assoc [ ("seq", `Int seq); ("hash", `String hash) ]) ]
    | None -> []
  in
  `Assoc (base @ at)
