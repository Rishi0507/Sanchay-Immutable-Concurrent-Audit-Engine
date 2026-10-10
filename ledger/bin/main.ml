(* Local entry point for the ledger core: read configuration, start both chains, serve the HTTP API. *)

let getenv name default = match Sys.getenv_opt name with Some v when v <> "" -> v | _ -> default

let () =
  let conninfo = getenv "DATABASE_URL" "postgres://ledger_rw:ledger_rw@localhost:5432/audit" in
  let catalogue_path = getenv "CATALOGUE_PATH" "../contracts/events.json" in
  let port = int_of_string (getenv "LEDGER_PORT" "7001") in
  let service_token = getenv "SERVICE_TOKEN" "dev-service-token" in
  let domains =
    match Sys.getenv_opt "VERIFY_DOMAINS" with
    | Some v when v <> "" -> int_of_string v
    | _ -> max 1 (min 8 (Domain.recommended_domain_count () - 1))
  in
  let catalogue =
    match Ledger.Catalogue.load catalogue_path with
    | Ok c -> c
    | Error msg -> prerr_endline ("catalogue: " ^ msg); exit 1
  in
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let business = Ledger.Business_chain.create ~sw ~conninfo ~catalogue in
  let trail = Ledger.Trail_chain.create ~sw ~conninfo in
  let api = { Ledger.Http_api.business; trail; conninfo; service_token; domains } in
  let socket =
    Eio.Net.listen env#net ~sw ~backlog:128 ~reuse_addr:true (`Tcp (Eio.Net.Ipaddr.V4.any, port))
  in
  Printf.printf "ledger listening on %d\n%!" port;
  let server = Cohttp_eio.Server.make ~callback:(Ledger.Http_api.handler api) () in
  Cohttp_eio.Server.run socket server ~on_error:(fun e -> prerr_endline (Printexc.to_string e))
