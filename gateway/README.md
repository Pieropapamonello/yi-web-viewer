# Gateway locale (da attivare dopo RTSP)

Questo componente deve girare nel PC/Raspberry della LAN, mai nel sito statico Render.

Responsabilità previste:

- leggere RTSP dalla FREDI e pubblicare HLS/WebRTC;
- esporre `POST /api/ptz` e `POST /api/ptz/preset` quando conosceremo l'API/ONVIF compatibile;
- registrare su disco locale con retention configurabile;
- inviare i file a Dropbox tramite OAuth e, opzionalmente, a MEGA tramite MEGAcmd;
- gestire autenticazione e token senza inviarli al browser.

Non configurare segreti Dropbox, MEGA o RTSP nel repository pubblico o in `web/config.js`.
