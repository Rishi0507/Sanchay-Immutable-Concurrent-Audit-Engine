type client = Identity.t
type auditor = Identity.t

let client_of_identity (id : Identity.t) : (client, Error.t) result =
  match id.role with
  | Identity.Client_employee -> Ok id
  | Identity.Auditor | Identity.Audit_manager ->
      Error.fail Error.Not_permitted
        "The %s role cannot change business data. Only client_employee can append events."
        (Identity.role_string id.role)

let auditor_of_identity (id : Identity.t) : (auditor, Error.t) result =
  match id.role with
  | Identity.Auditor | Identity.Audit_manager -> Ok id
  | Identity.Client_employee ->
      Error.fail Error.Not_permitted "The client_employee role cannot read the audit snapshot."

let identity_of_client c = c
let identity_of_auditor a = a
