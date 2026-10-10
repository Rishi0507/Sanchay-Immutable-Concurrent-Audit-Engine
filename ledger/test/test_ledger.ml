(* Unit tests for the pure parts of the ledger core. They need no database. *)

open Ledger

let failures = ref 0

let check name cond =
  if cond then Printf.printf "ok    %s\n" name
  else (
    incr failures;
    Printf.printf "FAIL  %s\n" name)

let json = Yojson.Safe.from_string

let is_code code = function Error (e : Error.t) -> e.Error.code = code | Ok _ -> false

let () =
  (* Posting: balanced by construction *)
  let balanced =
    Posting.make
      [ Posting.debit Account.Trade_receivables 11800; Posting.credit Account.Sales_revenue 10000;
        Posting.credit Account.Igst_output 1800 ]
  in
  check "balanced posting is accepted" (Result.is_ok balanced);
  check "unbalanced posting is refused"
    (is_code Error.Unbalanced_posting
       (Posting.make [ Posting.debit Account.Bank 100; Posting.credit Account.Sales_revenue 99 ]));
  check "zero lines are dropped"
    (match Posting.make [ Posting.debit Account.Bank 0; Posting.credit Account.Bank 0 ] with
    | Ok p -> Posting.is_empty p
    | Error _ -> false);
  (match balanced with
  | Ok p ->
      let m = Posting.mirror p in
      check "mirror keeps the total" (Posting.total m = Posting.total p);
      check "mirror swaps sides"
        (List.for_all2
           (fun (a : Posting.line) (b : Posting.line) -> a.debit = b.credit && a.credit = b.debit)
           (Posting.lines p) (Posting.lines m))
  | Error _ -> ());

  (* Posting rules *)
  let invoice =
    json
      {|{"taxable_value":10000000,"freight":50000,"cgst":0,"sgst":0,"igst":1809000,
         "tcs":0,"round_off":-50,"gross":11858950}|}
  in
  (match Posting_rules.derive Event_kind.Invoice_issued invoice ~target:None with
  | Ok p ->
      check "invoice posts the gross to receivables" (Posting.total p = 11859000);
      check "invoice credits revenue with the taxable value"
        (List.exists
           (fun (l : Posting.line) -> l.account = Account.Sales_revenue && l.credit = 10000000)
           (Posting.lines p))
  | Error e -> check ("invoice posting: " ^ e.Error.message) false);
  check "invoice whose gross does not foot is refused"
    (is_code Error.Unbalanced_posting
       (Posting_rules.derive Event_kind.Invoice_issued
          (json {|{"taxable_value":10000,"igst":1800,"gross":12000}|})
          ~target:None));
  check "invoice with no gross is refused"
    (is_code Error.Validation_failed
       (Posting_rules.derive Event_kind.Invoice_issued (json {|{"taxable_value":10000}|}) ~target:None));
  check "negative amount is refused"
    (is_code Error.Validation_failed
       (Posting_rules.derive Event_kind.Receipt_recorded (json {|{"amount":-5}|}) ~target:None));
  check "journal crediting sales is accepted when it balances"
    (Result.is_ok
       (Posting_rules.derive Event_kind.Journal_posted
          (json {|{"lines":[{"account":"9000","debit":500000},{"account":"4000","credit":500000}]}|})
          ~target:None));
  check "journal with an unknown account is refused"
    (is_code Error.Validation_failed
       (Posting_rules.derive Event_kind.Journal_posted
          (json {|{"lines":[{"account":"1234","debit":5},{"account":"4000","credit":5}]}|})
          ~target:None));
  check "unbalanced journal is refused"
    (is_code Error.Unbalanced_posting
       (Posting_rules.derive Event_kind.Journal_posted
          (json {|{"lines":[{"account":"9000","debit":5},{"account":"4000","credit":6}]}|})
          ~target:None));
  check "a dispatch posts nothing"
    (match Posting_rules.derive Event_kind.Dispatch_recorded (json "{}") ~target:None with
    | Ok p -> Posting.is_empty p
    | Error _ -> false);
  check "every kind round-trips through its name"
    (List.for_all (fun k -> Event_kind.of_string (Event_kind.to_string k) = Some k) Event_kind.all);

  (* Canonical JSON *)
  check "keys are sorted and whitespace removed"
    (Canonical.to_string (json {| { "b": 1, "a": [true, null] } |}) = {|{"a":[true,null],"b":1}|});
  check "a float with a zero fraction is written as an integer"
    (Canonical.to_string (json {|{"x":100.0,"y":1e2}|}) = {|{"x":100,"y":100}|});
  check "the canonical form survives a reorder"
    (Canonical.to_string (json {|{"a":{"d":1,"c":2},"b":"x"}|})
    = Canonical.to_string (json {|{"b":"x","a":{"c":2,"d":1}}|}));

  (* Hash chain *)
  let c1 = json {|{"seq":1}|} and c2 = json {|{"seq":2}|} in
  let h1 = Hash.chain ~prev_hash:Hash.genesis ~content:c1 in
  let h2 = Hash.chain ~prev_hash:h1 ~content:c2 in
  check "a hash is 64 hexadecimal characters" (String.length h1 = 64);
  check "the chain depends on the previous hash"
    (h2 <> Hash.chain ~prev_hash:Hash.genesis ~content:c2);
  check "known SHA-256 value"
    (Hash.sha256 "abc" = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  (* Merkle proofs for every leaf of trees of 1 to 9 leaves *)
  let all_ok = ref true in
  for n = 1 to 9 do
    let leaves = List.init n (fun i -> Hash.sha256 (string_of_int i)) in
    match Hash.Merkle.root leaves with
    | None -> all_ok := false
    | Some root ->
        List.iteri
          (fun i leaf ->
            match Hash.Merkle.proof leaves i with
            | Some path -> if Hash.Merkle.fold_proof leaf path <> root then all_ok := false
            | None -> all_ok := false)
          leaves
  done;
  check "every Merkle proof folds to the root" !all_ok;
  check "an empty day has no root" (Hash.Merkle.root [] = None);

  (* Capabilities *)
  let id role = { Identity.user = "u"; role } in
  check "a client employee obtains a write capability"
    (Result.is_ok (Capability.client_of_identity (id Identity.Client_employee)));
  check "an auditor cannot obtain a write capability"
    (is_code Error.Not_permitted (Capability.client_of_identity (id Identity.Auditor)));
  check "an audit manager cannot obtain a write capability"
    (is_code Error.Not_permitted (Capability.client_of_identity (id Identity.Audit_manager)));

  (* Clock *)
  check "timestamp has microsecond precision"
    (String.length (Clock.now_utc ()) = 27 && (Clock.now_utc ()).[26] = 'Z');
  check "date check" (Clock.is_date "2025-03-31" && not (Clock.is_date "31-03-2025"));

  if !failures > 0 then (
    Printf.printf "%d test(s) failed\n" !failures;
    exit 1)
  else print_endline "all tests passed"
