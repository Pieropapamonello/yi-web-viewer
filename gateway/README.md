# Gateway locale IPC365

Questo componente deve girare nel PC/Raspberry della LAN, mai nel sito statico Render.

Responsabilità:

- leggere RTSP dalla FREDI e pubblicare HLS/WebRTC;
- esporre `POST /api/ptz` tramite protocollo TCP IPC365 verificato e `GET /api/capabilities`;
- registrare su disco locale con retention configurabile;
- inviare i file a Dropbox tramite OAuth e, opzionalmente, a MEGA tramite MEGAcmd;
- gestire autenticazione e token senza inviarli al browser.

`IPC365_SOURCE_ID` e `IPC365_DEVICE_ID` vanno nel file locale `onvif.env`; il formato è composto da 8 caratteri esadecimali per valore. Non configurare segreti Dropbox, MEGA o RTSP nel repository pubblico o in `web/config.js`.
