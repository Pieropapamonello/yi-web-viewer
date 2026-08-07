# Yi Web Viewer

Una web app senza pubblicita' per vedere telecamere RTSP/ONVIF. Il primo flusso attivo e' una IPC365 1080p; la FREDI G1 rimane predisposta in attesa di RTSP.

```text
IPC365 RTSP -> FFmpeg bridge -> MediaMTX nella LAN -> HLS (.m3u8)
                                      |
                         EasyProxy opzionale (solo HLS)
                                      |
                          web/index.html con hls.js
```

Render puo' ospitare la pagina web e, opzionalmente, EasyProxy. Non puo' collegarsi direttamente a `192.168.x.x`: la conversione RTSP deve rimanere su un PC, Raspberry o mini-server sempre acceso nella stessa LAN della camera.

## Avvio locale

1. Installa Docker Desktop.
2. Copia `.env.example` in `.env` e inserisci il vero `IPC365_RTSP_URL`.
3. Avvia gateway e viewer:

   ```powershell
   docker compose up -d
   ```

4. Apri `http://localhost:8080`.

Il browser legge HLS da `http://localhost:8890/ipc365/index.m3u8`. La porta 8890 evita il conflitto con EasyProxy, che nello stack esistente usa gia' la porta host 8888.

La IPC365 testata espone H.264 1920x1080 sul percorso:

```text
rtsp://IP_CAMERA:554/cam/realmonitor?channel=1&subtype=0
```

Il bridge FFmpeg e' necessario perche' il server RTSP della camera restituisce un header `Transport` non standard. La porta RTSP 554 deve rimanere accessibile soltanto nella LAN.

### Nginx Proxy Manager e Render

MediaMTX e' collegato alla rete Docker esterna `proxy-net`, condivisa con Nginx Proxy Manager. Per fornire HLS alla pagina HTTPS su Render:

1. crea in Nginx Proxy Manager un Proxy Host HTTPS dedicato;
2. usa `camera-mediamtx` come **Forward Hostname** e `8888` come **Forward Port**;
3. richiedi un certificato SSL valido e abilita Force SSL;
4. proteggi il proxy con una Access List o, preferibilmente, un gateway autenticato;
5. usa nell'app l'URL `https://DOMINIO/ipc365/index.m3u8`.

Non impostare l'URL HTTP locale nella pagina Render: i browser bloccano i contenuti HTTP caricati da una pagina HTTPS.

### Controlli PTZ tramite ONVIF

HLS trasporta soltanto il video. I pulsanti direzionali usano il gateway autenticato in `gateway/onvif-api`, che conserva le credenziali ONVIF esclusivamente sul PC di casa.

Nel setup MediaFlow locale:

```powershell
powershell -ExecutionPolicy Bypass -File C:\mediaflow\camera\setup-onvif.ps1
docker compose -p mediaflow -f C:\mediaflow\docker-compose.yml -f C:\mediaflow\docker-compose.camera.yml up -d --build onvif-gateway
```

La prima istruzione apre la finestra credenziali di Windows. Inserisci l'utente ONVIF (normalmente `admin`) e la password definita nell'app della camera. Lo script crea `C:\mediaflow\camera\onvif.env` e mostra un token API casuale da copiare nella dashboard. Il file e il token non devono essere pubblicati.

In Nginx Proxy Manager crea poi un host HTTPS separato:

```text
control.nelloonrender.duckdns.org -> http://onvif-gateway:3000
```

Nella dashboard Render imposta:

- URL API PTZ: `https://control.nelloonrender.duckdns.org`
- Token API PTZ: il token prodotto dallo script
- utente/password HLS: le credenziali della Access List Nginx, non quelle ONVIF

Le password HLS e il token API sono conservati in `sessionStorage` e vengono richiesti nuovamente quando termina la sessione del browser.

### EasyProxy opzionale

EasyProxy e' utile per proxy, CORS, header e playlist HLS. Non converte RTSP. Per avviarlo localmente:

```powershell
docker compose --profile proxy up -d
```

Usa il suo endpoint solo con un URL HLS, per esempio:

```text
http://localhost:7860/proxy/manifest.m3u8?url=http%3A%2F%2Fmediamtx%3A8888%2Fyi%2Findex.m3u8
```

Nel browser o da un host diverso dal container, sostituisci `mediamtx` con l'IP/nome raggiungibile del gateway. Non pubblicare EasyProxy senza password forte, autenticazione per i visitatori e senza limitare quali URL puo' proxyare: un proxy URL pubblico puo' essere abusato.

## Deploy della pagina su Render

1. Carica questi file su GitHub lasciando sempre fuori `.env` e ogni credenziale.
2. In Render: **New > Blueprint**, collega il repository e scegli `render.yaml`.
3. Render pubblica `web/` come Static Site e assegna un dominio `onrender.com`.
4. Imposta `streamUrl` in `web/config.js` all'URL **HTTPS pubblico** del tuo gateway HLS o del tuo proxy EasyProxy. Non inserire password RTSP o token in questo file.
5. Effettua commit e push di `web/config.js` solo se l'URL puo' essere pubblico. Altrimenti configura un backend autenticato prima del deploy.

Il `render.yaml` distribuisce intenzionalmente solo l'interfaccia. Per distribuire EasyProxy su Render, crea un secondo Web Service Docker dal file `render/easyproxy.Dockerfile`, porta `10000`, e imposta `API_PASSWORD` come secret nel pannello Render. Un servizio Render EasyProxy puo' leggere soltanto un HLS che sia gia' raggiungibile in Internet: non puo' vedere l'IP LAN della Yi.

## Accesso remoto sicuro

Per vedere la camera fuori casa devi esporre **HLS/WebRTC**, non RTSP e non la porta di amministrazione della Yi. Usa un tunnel HTTPS autenticato o un VPS, proteggi il viewer con login e conserva RTSP/token solo in variabili segrete locali. Un tunnel e' un prerequisito esterno: non viene avviato da questo repository per evitare di rendere pubblica la camera per errore.

## Fermare i contenitori

```powershell
docker compose down
```
