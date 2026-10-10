(* Single-writer sequencer (LC-4).

   One fiber owns a chain. Every operation on the chain is sent to that fiber
   through a mailbox and runs there to completion before the next one starts.
   Two appends can therefore never read the same head, so the chain cannot
   fork, and the idempotency check and the insert are one indivisible step
   (LC-5). The same code serves the business chain and the trail chain, each
   with its own instance (LC-9). *)

type t = { mailbox : (unit -> unit) Eio.Stream.t }

let create ~sw ?(capacity = 4096) () : t =
  let mailbox = Eio.Stream.create capacity in
  Eio.Fiber.fork_daemon ~sw (fun () ->
      let rec loop () =
        let job = Eio.Stream.take mailbox in
        job ();
        loop ()
      in
      loop ());
  { mailbox }

(* Runs [f] on the sequencer fiber and waits for its result. *)
let submit (t : t) (f : unit -> 'a) : 'a =
  let promise, resolver = Eio.Promise.create () in
  Eio.Stream.add t.mailbox (fun () ->
      let outcome = try Ok (f ()) with e -> Error e in
      Eio.Promise.resolve resolver outcome);
  match Eio.Promise.await promise with Ok v -> v | Error e -> raise e
