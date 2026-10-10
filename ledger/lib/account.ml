(* Chart of accounts (PRD section 7.1). A posting line can only name an
   account that exists here. *)

type t =
  | Bank
  | Trade_receivables
  | Gst_input_credit
  | Trade_payables
  | Cgst_output
  | Sgst_output
  | Igst_output
  | Tcs_payable
  | Sales_revenue
  | Sales_returns
  | Freight_packing_insurance
  | Round_off
  | Purchases
  | Suspense

let all =
  [
    Bank; Trade_receivables; Gst_input_credit; Trade_payables; Cgst_output; Sgst_output;
    Igst_output; Tcs_payable; Sales_revenue; Sales_returns; Freight_packing_insurance;
    Round_off; Purchases; Suspense;
  ]

let code = function
  | Bank -> "1000"
  | Trade_receivables -> "1100"
  | Gst_input_credit -> "1300"
  | Trade_payables -> "2000"
  | Cgst_output -> "2100"
  | Sgst_output -> "2101"
  | Igst_output -> "2102"
  | Tcs_payable -> "2200"
  | Sales_revenue -> "4000"
  | Sales_returns -> "4100"
  | Freight_packing_insurance -> "4200"
  | Round_off -> "4900"
  | Purchases -> "5000"
  | Suspense -> "9000"

let of_code c = List.find_opt (fun a -> String.equal (code a) c) all
