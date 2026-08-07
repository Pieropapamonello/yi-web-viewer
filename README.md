# Yi Web Viewer

Una web app senza pubblicita' per vedere una Yi che espone RTSP. Il repository contiene tre ruoli separati:

```text
Yi RTSP -> MediaMTX nella LAN -> HLS (.m3u8)
                                      |
                         EasyProxy opzionale (solo HLS)
                                      |
                          web/index.html con hls.js
```

Render puo' ospitare la pagina web e, opzionalmente, EasyProxy. Non puo' collegarsi direttamente a `192.168.x.x`: la conversione RTSP deve rimanere su un PC, Raspberry o mini-server sempre acceso nella stessa LAN della camera.

## Avvio locale

1. Installa Docker Desktop.
2. Copia `.env.example` in `.env` e inserisci il vero `RTSP_URL`.
3. Avvia gateway e viewer:

   ```powershell
   docker compose up -d
   ```

4. Apri `http://localhost:8080`.

Il browser legge HLS da `http://localhost:8888/yi/index.m3u8`.

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

1. Crea un repository **privato** su GitHub e carica questi file, lasciando fuori `.env`.
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
