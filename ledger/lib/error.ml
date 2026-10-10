(* Errors the ledger core returns. The codes are part of the contract in
   contracts/ledger-api.md. *)

type code =
  | Validation_failed
  | Not_permitted
  | Unknown_reference
  | Version_conflict
  | Invalid_transition
  | Idempotency_mismatch
  | Unbalanced_posting
  | Not_found
  | Internal

type t = { code : code; message : string }

let make code message = { code; message }
let fail code fmt = Printf.ksprintf (fun message -> Error { code; message }) fmt

let code_string = function
  | Validation_failed -> "VALIDATION_FAILED"
  | Not_permitted -> "NOT_PERMITTED"
  | Unknown_reference -> "UNKNOWN_REFERENCE"
  | Version_conflict -> "VERSION_CONFLICT"
  | Invalid_transition -> "INVALID_TRANSITION"
  | Idempotency_mismatch -> "IDEMPOTENCY_MISMATCH"
  | Unbalanced_posting -> "UNBALANCED_POSTING"
  | Not_found -> "NOT_FOUND"
  | Internal -> "INTERNAL_ERROR"

let http_status = function
  | Validation_failed -> 400
  | Not_permitted -> 403
  | Unknown_reference | Not_found -> 404
  | Version_conflict | Invalid_transition | Idempotency_mismatch -> 409
  | Unbalanced_posting -> 422
  | Internal -> 500

let to_json e : Yojson.Safe.t =
  `Assoc
    [
      ( "error",
        `Assoc
          [ ("code", `String (code_string e.code)); ("message", `String e.message) ] );
    ]

let ( let* ) = Result.bind
