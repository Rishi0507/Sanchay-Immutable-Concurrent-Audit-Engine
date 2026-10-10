(** Capabilities decide what a caller may do to the business chain.

    Appending needs a value of type {!client}. The only function that
    produces one is {!client_of_identity}, and it refuses every role except
    [client_employee]. There is no function from {!auditor} to {!client}, so
    code that holds an auditor capability has no way to reach the append
    path: the restriction is checked by the compiler, not by a run-time test
    that could be forgotten (LC-3, PRD section 4.3 layer L2). *)

type client
(** May append business events. *)

type auditor
(** May only read. *)

val client_of_identity : Identity.t -> (client, Error.t) result
val auditor_of_identity : Identity.t -> (auditor, Error.t) result

val identity_of_client : client -> Identity.t
val identity_of_auditor : auditor -> Identity.t
