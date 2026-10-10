(* Canonical JSON: the exact byte string that is hashed.

   Object keys are sorted by byte order, there is no whitespace, and a number
   with a zero fraction is written as an integer. The last rule makes the form
   stable across a round trip through Postgres jsonb, which stores numbers as
   numeric and may return 100 where 1e2 or 100.0 was sent. *)

let float_repr f =
  if Float.is_integer f then Printf.sprintf "%.0f" f else Printf.sprintf "%.17g" f

let rec write buf (j : Yojson.Safe.t) =
  match j with
  | `Null -> Buffer.add_string buf "null"
  | `Bool b -> Buffer.add_string buf (if b then "true" else "false")
  | `Int i -> Buffer.add_string buf (string_of_int i)
  | `Intlit s -> (
      (* An integer too large for a native int. Write it the way the same
         value would be written if it had arrived as a float. *)
      match float_of_string_opt s with
      | Some f -> Buffer.add_string buf (float_repr f)
      | None -> Buffer.add_string buf s)
  | `Float f -> Buffer.add_string buf (float_repr f)
  | `String s -> Buffer.add_string buf (Yojson.Safe.to_string (`String s))
  | `List items ->
      Buffer.add_char buf '[';
      List.iteri
        (fun i item ->
          if i > 0 then Buffer.add_char buf ',';
          write buf item)
        items;
      Buffer.add_char buf ']'
  | `Assoc fields ->
      let sorted = List.sort (fun (a, _) (b, _) -> String.compare a b) fields in
      Buffer.add_char buf '{';
      List.iteri
        (fun i (k, v) ->
          if i > 0 then Buffer.add_char buf ',';
          Buffer.add_string buf (Yojson.Safe.to_string (`String k));
          Buffer.add_char buf ':';
          write buf v)
        sorted;
      Buffer.add_char buf '}'

let to_string (j : Yojson.Safe.t) =
  let buf = Buffer.create 512 in
  write buf j;
  Buffer.contents buf
