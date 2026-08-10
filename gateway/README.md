# Gateway locale IPC365

Questo componente deve girare nel PC/Raspberry della LAN, mai nel sito statico Render.

Responsabilità:

- leggere RTSP dalla FREDI e pubblicare HLS/WebRTC;
- esporre `POST /api/ptz` tramite protocollo TCP IPC365 verificato e `GET /api/capabilities`;
- controllare luce, visione notturna, sirena, tracking hardware, zoom ottico e modalità TF quando sono disponibili comandi verificati;
- registrare su disco locale con retention configurabile;
- inviare i file a Dropbox tramite OAuth e, opzionalmente, a MEGA tramite MEGAcmd;
- gestire autenticazione e token senza inviarli al browser.

`IPC365_SOURCE_ID` e `IPC365_DEVICE_ID` vanno nel file locale `onvif.env`; il formato è composto da 8 caratteri esadecimali per valore. Non configurare segreti Dropbox, MEGA o RTSP nel repository pubblico o in `web/config.js`.

## Funzioni dispositivo

La dashboard usa `GET /api/device/state` e `POST /api/device/action`. Un controllo
compare soltanto quando il gateway possiede l'insieme completo di comandi. Per
IPC360, ogni voce di `IPC365_DEVICE_COMMANDS_JSON` contiene richiesta e firma di
risposta in base64:

```json
{
  "light:on": { "frame": "BASE64_REQUEST", "expect": "BASE64_ACK" },
  "light:off": { "frame": "BASE64_REQUEST", "expect": "BASE64_ACK" },
  "light:auto": { "frame": "BASE64_REQUEST", "expect": "BASE64_ACK" }
}
```

Sono consentite esclusivamente `light:off/on/auto`,
`nightVision:off/on/auto`, `alarm:off/on`, `tracking:off/on`,
`zoom:in/out/stop` e `sdRecording:off/continuous/event`. Il gateway riscrive
gli ID IPC365 agli offset 20/24 e considera il comando riuscito solo quando
riceve `expect`; un semplice invio TCP non viene indicato come successo.

Per FREDI, `FREDI_DEVICE_COMMANDS_JSON` associa le stesse azioni a comandi fissi
di un helper installato sulla microSD. Il browser non può inviare testo shell
arbitrario e viene controllato il codice di uscita dell'helper. Senza helper i
relativi pulsanti restano disabilitati.

La modalità TF firmware è distinta dall'archivio diretto FREDI: seleziona
registrazione continua/eventi sulla camera, mentre timeline, download e
cancellazione richiedono anche il driver playback specifico del modello.

L'audio bidirezionale FREDI usa per impostazione predefinita il dispositivo
ALSA analogico `1`; può essere cambiato con `FREDI_TALK_DEVICE`. Il pulsante
Parla viene pubblicato soltanto quando `talkd` risponde realmente. Per IPC365
resta disabilitato finché `IPC365_TALK_ENABLED=true` non viene impostato dopo
una cattura completa e una verifica del protocollo del modello.

Il controllo PTZ continuo usa `ptzd` sulla porta LAN `23459`: la pressione
avvia subito il motore e il rilascio invia uno stop separato. Se il browser
scompare o lo stop non arriva, il gateway arresta comunque il movimento dopo
15 secondi. Il vecchio comando Telnet rimane come ripiego per gli stop.
