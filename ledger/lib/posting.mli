(** A balanced set of ledger lines.

    [t] is abstract. The only ways to obtain one are {!none}, {!make} and
    {!mirror}, and each of them guarantees that total debits equal total
    credits. An unbalanced posting therefore cannot be represented, and no
    code path can write one (LC-1, LG-2). *)

type line = private { account : Account.t; debit : int; credit : int }
(** Amounts are integer paise (LG-3). Exactly one of [debit] and [credit] is
    positive. *)

type t

val debit : Account.t -> int -> line option
(** [debit a n] is a debit line, or [None] when [n] is zero. A negative [n]
    becomes a credit of the same size. *)

val credit : Account.t -> int -> line option
(** [credit a n] is a credit line, or [None] when [n] is zero. A negative [n]
    becomes a debit of the same size. *)

val none : t
(** The posting of an event that does not touch the ledger. *)

val make : line option list -> (t, Error.t) result
(** [make lines] drops the [None] entries and returns the posting when it
    balances, and [Error Unbalanced_posting] otherwise. *)

val mirror : t -> t
(** [mirror p] swaps debits and credits. It is the posting of a reversal. *)

val lines : t -> line list
val is_empty : t -> bool
val total : t -> int
val to_json : t -> Yojson.Safe.t
