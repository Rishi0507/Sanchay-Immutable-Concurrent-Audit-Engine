(* Who caused an event or a tool call. The MCP server resolves it from a
   bearer token and passes it on. *)

type role = Client_employee | Auditor | Audit_manager

type t = { user : string; role : role }

let role_string = function
  | Client_employee -> "client_employee"
  | Auditor -> "auditor"
  | Audit_manager -> "audit_manager"

let role_of_string = function
  | "client_employee" -> Some Client_employee
  | "auditor" -> Some Auditor
  | "audit_manager" -> Some Audit_manager
  | _ -> None

let to_json t : Yojson.Safe.t =
  `Assoc [ ("role", `String (role_string t.role)); ("user", `String t.user) ]

let of_json (j : Yojson.Safe.t) : (t, Error.t) result =
  match j with
  | `Assoc fields -> (
      match (List.assoc_opt "user" fields, List.assoc_opt "role" fields) with
      | Some (`String user), Some (`String role) when user <> "" -> (
          match role_of_string role with
          | Some role -> Ok { user; role }
          | None -> Error.fail Error.Validation_failed "identity.role %S is not a known role." role)
      | _ -> Error.fail Error.Validation_failed "identity needs a user and a role.")
  | _ -> Error.fail Error.Validation_failed "identity must be an object."
