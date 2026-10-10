(* SHA-256 helpers, the chain rule and Merkle roots.
   See the Hashing section of contracts/ledger-api.md. *)

let sha256 (s : string) : string = Digestif.SHA256.(to_hex (digest_string s))

let genesis = String.make 64 '0'

(* hash_n = SHA256(prev_hash || canonical_json(content_n)) *)
let chain ~prev_hash ~(content : Yojson.Safe.t) : string =
  sha256 (prev_hash ^ Canonical.to_string content)

let chain_raw ~prev_hash ~(canonical : string) : string = sha256 (prev_hash ^ canonical)

module Merkle = struct
  type side = Left | Right

  let pair a b = sha256 (a ^ b)

  (* One level up. An odd node at the end is carried up unchanged. *)
  let rec level = function
    | a :: b :: rest -> pair a b :: level rest
    | [ a ] -> [ a ]
    | [] -> []

  let rec root = function
    | [] -> None
    | [ h ] -> Some h
    | leaves -> root (level leaves)

  (* The path that proves the leaf at [index] belongs to the root. Each step
     names the sibling and the side it sits on. *)
  let proof (leaves : string list) (index : int) : (side * string) list option =
    let n = List.length leaves in
    if index < 0 || index >= n then None
    else
      let rec go nodes idx acc =
        match nodes with
        | [] | [ _ ] -> List.rev acc
        | _ ->
            let arr = Array.of_list nodes in
            let len = Array.length arr in
            let acc =
              if idx land 1 = 1 then (Left, arr.(idx - 1)) :: acc
              else if idx + 1 < len then (Right, arr.(idx + 1)) :: acc
              else acc
            in
            go (level nodes) (idx / 2) acc
      in
      Some (go leaves index [])

  let fold_proof (leaf : string) (path : (side * string) list) : string =
    List.fold_left
      (fun current (side, sibling) ->
        match side with Left -> pair sibling current | Right -> pair current sibling)
      leaf path
end
