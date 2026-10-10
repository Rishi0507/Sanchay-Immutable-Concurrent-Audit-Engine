(* Posting rules (PRD section 7.2): the ledger lines each event produces.

   [derive] is a total function over [Event_kind.t] with no wildcard case.
   The caller never supplies postings, except the lines of a manual journal,
   and those still pass through [Posting.make]. *)

open Error

let field (payload : Yojson.Safe.t) name =
  match payload with `Assoc fields -> List.assoc_opt name fields | _ -> None

(* An amount in integer paise. [signed] allows a negative value. *)
let amount ?(signed = false) ?(required = false) payload name : (int, Error.t) result =
  let checked n =
    if n < 0 && not signed then
      Error.fail Error.Validation_failed "%s must not be negative." name
    else Ok n
  in
  match field payload name with
  | None | Some `Null ->
      if required then Error.fail Error.Validation_failed "%s is required." name else Ok 0
  | Some (`Int n) -> checked n
  | Some (`Float f) when Float.is_integer f -> checked (int_of_float f)
  | Some (`Intlit s) -> (
      match int_of_string_opt s with
      | Some n -> checked n
      | None -> Error.fail Error.Validation_failed "%s is out of range." name)
  | Some _ -> Error.fail Error.Validation_failed "%s must be a whole number of paise." name

let invoice payload =
  let* gross = amount ~required:true payload "gross" in
  let* taxable = amount ~required:true payload "taxable_value" in
  let* packing = amount payload "packing" in
  let* freight = amount payload "freight" in
  let* insurance = amount payload "insurance" in
  let* cgst = amount payload "cgst" in
  let* sgst = amount payload "sgst" in
  let* igst = amount payload "igst" in
  let* tcs = amount payload "tcs" in
  let* round_off = amount ~signed:true payload "round_off" in
  Posting.make
    [
      Posting.debit Account.Trade_receivables gross;
      Posting.credit Account.Sales_revenue taxable;
      Posting.credit Account.Freight_packing_insurance (packing + freight + insurance);
      Posting.credit Account.Cgst_output cgst;
      Posting.credit Account.Sgst_output sgst;
      Posting.credit Account.Igst_output igst;
      Posting.credit Account.Tcs_payable tcs;
      Posting.credit Account.Round_off round_off;
    ]

let receipt payload =
  let* amt = amount ~required:true payload "amount" in
  Posting.make
    [ Posting.debit Account.Bank amt; Posting.credit Account.Trade_receivables amt ]

let credit_note payload =
  let* gross = amount ~required:true payload "gross" in
  let* taxable = amount ~required:true payload "taxable_value" in
  let* cgst = amount payload "cgst" in
  let* sgst = amount payload "sgst" in
  let* igst = amount payload "igst" in
  Posting.make
    [
      Posting.debit Account.Sales_returns taxable;
      Posting.debit Account.Cgst_output cgst;
      Posting.debit Account.Sgst_output sgst;
      Posting.debit Account.Igst_output igst;
      Posting.credit Account.Trade_receivables gross;
    ]

let purchase_invoice payload =
  let* gross = amount ~required:true payload "gross" in
  let* taxable = amount ~required:true payload "taxable_value" in
  let* tax = amount payload "tax" in
  Posting.make
    [
      Posting.debit Account.Purchases taxable;
      Posting.debit Account.Gst_input_credit tax;
      Posting.credit Account.Trade_payables gross;
    ]

let payment payload =
  let* amt = amount ~required:true payload "amount" in
  Posting.make [ Posting.debit Account.Trade_payables amt; Posting.credit Account.Bank amt ]

let journal payload =
  match field payload "lines" with
  | Some (`List (_ :: _ as lines)) ->
      let rec collect acc = function
        | [] -> Ok (List.rev acc)
        | line :: rest -> (
            match field line "account" with
            | Some (`String code) -> (
                match Account.of_code code with
                | None ->
                    Error.fail Error.Validation_failed
                      "Journal line names account %s, which is not in the chart of accounts." code
                | Some account ->
                    let* d = amount line "debit" in
                    let* c = amount line "credit" in
                    if d > 0 && c > 0 then
                      Error.fail Error.Validation_failed
                        "A journal line carries a debit or a credit, not both (account %s)." code
                    else if d = 0 && c = 0 then
                      Error.fail Error.Validation_failed
                        "A journal line needs a debit or a credit (account %s)." code
                    else
                      let l =
                        if d > 0 then Posting.debit account d else Posting.credit account c
                      in
                      collect (l :: acc) rest)
            | _ -> Error.fail Error.Validation_failed "Every journal line needs an account code.")
      in
      let* lines = collect [] lines in
      Posting.make lines
  | _ -> Error.fail Error.Validation_failed "A journal needs at least one line."

(* [target] is the posting of the document being reversed, when it posted. *)
let derive (kind : Event_kind.t) (payload : Yojson.Safe.t) ~(target : Posting.t option) :
    (Posting.t, Error.t) result =
  match kind with
  | Event_kind.Invoice_issued -> invoice payload
  | Event_kind.Receipt_recorded -> receipt payload
  | Event_kind.Credit_note_issued -> credit_note payload
  | Event_kind.Purchase_invoice_recorded -> purchase_invoice payload
  | Event_kind.Payment_made -> payment payload
  | Event_kind.Journal_posted -> journal payload
  | Event_kind.Document_reversed -> (
      match target with Some p -> Ok (Posting.mirror p) | None -> Ok Posting.none)
  | Event_kind.Customer_created | Event_kind.Customer_updated | Event_kind.Vendor_created
  | Event_kind.Vendor_updated | Event_kind.Company_officer_recorded | Event_kind.Price_set
  | Event_kind.Promotion_created | Event_kind.Enquiry_recorded
  | Event_kind.Sales_order_created | Event_kind.Dispatch_recorded
  | Event_kind.Eway_bill_generated | Event_kind.Lorry_receipt_recorded
  | Event_kind.Delivery_recorded | Event_kind.Gstr1_filed
  | Event_kind.Bank_statement_imported | Event_kind.Sales_return_recorded
  | Event_kind.Goods_receipt_recorded | Event_kind.Sales_register_uploaded
  | Event_kind.Related_party_list_uploaded | Event_kind.Evidence_uploaded ->
      Ok Posting.none

(* Whether a kind can produce ledger lines. Checked against the catalogue at
   start-up so the contract and the code cannot drift apart. *)
let posts (kind : Event_kind.t) : bool =
  match kind with
  | Event_kind.Invoice_issued | Event_kind.Receipt_recorded | Event_kind.Credit_note_issued
  | Event_kind.Purchase_invoice_recorded | Event_kind.Payment_made
  | Event_kind.Journal_posted | Event_kind.Document_reversed ->
      true
  | Event_kind.Customer_created | Event_kind.Customer_updated | Event_kind.Vendor_created
  | Event_kind.Vendor_updated | Event_kind.Company_officer_recorded | Event_kind.Price_set
  | Event_kind.Promotion_created | Event_kind.Enquiry_recorded
  | Event_kind.Sales_order_created | Event_kind.Dispatch_recorded
  | Event_kind.Eway_bill_generated | Event_kind.Lorry_receipt_recorded
  | Event_kind.Delivery_recorded | Event_kind.Gstr1_filed
  | Event_kind.Bank_statement_imported | Event_kind.Sales_return_recorded
  | Event_kind.Goods_receipt_recorded | Event_kind.Sales_register_uploaded
  | Event_kind.Related_party_list_uploaded | Event_kind.Evidence_uploaded ->
      false
