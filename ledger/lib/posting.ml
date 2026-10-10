type line = { account : Account.t; debit : int; credit : int }
type t = line list

let debit account n =
  if n = 0 then None
  else if n > 0 then Some { account; debit = n; credit = 0 }
  else Some { account; debit = 0; credit = -n }

let credit account n =
  if n = 0 then None
  else if n > 0 then Some { account; debit = 0; credit = n }
  else Some { account; debit = -n; credit = 0 }

let none = []

let make (candidates : line option list) : (t, Error.t) result =
  let lines = List.filter_map Fun.id candidates in
  let d = List.fold_left (fun acc l -> acc + l.debit) 0 lines in
  let c = List.fold_left (fun acc l -> acc + l.credit) 0 lines in
  if d = c then Ok lines
  else
    Error.fail Error.Unbalanced_posting
      "Debits of %d paise do not equal credits of %d paise. The difference is %d paise." d c
      (d - c)

let mirror (t : t) : t =
  List.map (fun l -> { account = l.account; debit = l.credit; credit = l.debit }) t

let lines t = t
let is_empty t = t = []
let total t = List.fold_left (fun acc l -> acc + l.debit) 0 t

let to_json (t : t) : Yojson.Safe.t =
  `List
    (List.map
       (fun l ->
         `Assoc
           [
             ("account", `String (Account.code l.account));
             ("credit", `Int l.credit);
             ("debit", `Int l.debit);
           ])
       t)
