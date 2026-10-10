(* UTC timestamps with microsecond precision, in the exact text form that is
   hashed and that Postgres returns for the stored value. *)

let format_utc (t : float) : string =
  let whole = Float.of_int (int_of_float (Float.floor t)) in
  let micros = int_of_float ((t -. whole) *. 1_000_000.) in
  let micros = max 0 (min 999_999 micros) in
  let tm = Unix.gmtime whole in
  Printf.sprintf "%04d-%02d-%02dT%02d:%02d:%02d.%06dZ" (tm.Unix.tm_year + 1900)
    (tm.Unix.tm_mon + 1) tm.Unix.tm_mday tm.Unix.tm_hour tm.Unix.tm_min tm.Unix.tm_sec micros

let now_utc () = format_utc (Unix.gettimeofday ())

let today_utc () = String.sub (now_utc ()) 0 10

let yesterday_utc () = String.sub (format_utc (Unix.gettimeofday () -. 86_400.)) 0 10

(* YYYY-MM-DD with plausible ranges. Postgres makes the final check. *)
let is_date (s : string) : bool =
  String.length s = 10
  && s.[4] = '-'
  && s.[7] = '-'
  &&
  let digits = [ 0; 1; 2; 3; 5; 6; 8; 9 ] in
  List.for_all (fun i -> s.[i] >= '0' && s.[i] <= '9') digits
