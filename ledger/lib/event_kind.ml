(* Every event type the ledger accepts (PRD section 6.3). The variant is
   closed: functions that match on it without a wildcard stop compiling when
   a kind is added, which is how a new event type is forced to declare its
   posting rule (LC-2). *)

type t =
  | Customer_created
  | Customer_updated
  | Vendor_created
  | Vendor_updated
  | Company_officer_recorded
  | Price_set
  | Promotion_created
  | Enquiry_recorded
  | Sales_order_created
  | Dispatch_recorded
  | Eway_bill_generated
  | Lorry_receipt_recorded
  | Delivery_recorded
  | Invoice_issued
  | Gstr1_filed
  | Receipt_recorded
  | Bank_statement_imported
  | Credit_note_issued
  | Sales_return_recorded
  | Purchase_invoice_recorded
  | Goods_receipt_recorded
  | Payment_made
  | Journal_posted
  | Document_reversed
  | Sales_register_uploaded
  | Related_party_list_uploaded
  | Evidence_uploaded

let all =
  [
    Customer_created; Customer_updated; Vendor_created; Vendor_updated;
    Company_officer_recorded; Price_set; Promotion_created; Enquiry_recorded;
    Sales_order_created; Dispatch_recorded; Eway_bill_generated; Lorry_receipt_recorded;
    Delivery_recorded; Invoice_issued; Gstr1_filed; Receipt_recorded;
    Bank_statement_imported; Credit_note_issued; Sales_return_recorded;
    Purchase_invoice_recorded; Goods_receipt_recorded; Payment_made; Journal_posted;
    Document_reversed; Sales_register_uploaded; Related_party_list_uploaded;
    Evidence_uploaded;
  ]

let to_string = function
  | Customer_created -> "CustomerCreated"
  | Customer_updated -> "CustomerUpdated"
  | Vendor_created -> "VendorCreated"
  | Vendor_updated -> "VendorUpdated"
  | Company_officer_recorded -> "CompanyOfficerRecorded"
  | Price_set -> "PriceSet"
  | Promotion_created -> "PromotionCreated"
  | Enquiry_recorded -> "EnquiryRecorded"
  | Sales_order_created -> "SalesOrderCreated"
  | Dispatch_recorded -> "DispatchRecorded"
  | Eway_bill_generated -> "EWayBillGenerated"
  | Lorry_receipt_recorded -> "LorryReceiptRecorded"
  | Delivery_recorded -> "DeliveryRecorded"
  | Invoice_issued -> "InvoiceIssued"
  | Gstr1_filed -> "Gstr1Filed"
  | Receipt_recorded -> "ReceiptRecorded"
  | Bank_statement_imported -> "BankStatementImported"
  | Credit_note_issued -> "CreditNoteIssued"
  | Sales_return_recorded -> "SalesReturnRecorded"
  | Purchase_invoice_recorded -> "PurchaseInvoiceRecorded"
  | Goods_receipt_recorded -> "GoodsReceiptRecorded"
  | Payment_made -> "PaymentMade"
  | Journal_posted -> "JournalPosted"
  | Document_reversed -> "DocumentReversed"
  | Sales_register_uploaded -> "SalesRegisterUploaded"
  | Related_party_list_uploaded -> "RelatedPartyListUploaded"
  | Evidence_uploaded -> "EvidenceUploaded"

let of_string s = List.find_opt (fun k -> String.equal (to_string k) s) all
