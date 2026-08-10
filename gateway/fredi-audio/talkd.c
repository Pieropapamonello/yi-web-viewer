#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#include "tinyalsa/pcm.h"
#include "tinyalsa/mixer.h"

#define DEFAULT_PORT 23457
#define AUDIO_BYTES 3200

static volatile sig_atomic_t running = 1;

static void stop_server(int signal_number) {
    (void)signal_number;
    running = 0;
}

static int authenticated(int client, const char *token) {
    char line[160];
    size_t used = 0;
    while (used + 1 < sizeof(line)) {
        const ssize_t count = recv(client, line + used, 1, 0);
        if (count <= 0) return 0;
        if (line[used] == '\n') { line[used] = '\0'; break; }
        if (line[used] != '\r') used++;
    }
    return strlen(token) >= 24 && strcmp(line, token) == 0;
}

static void enable_speaker_route(void) {
    struct mixer *mixer = mixer_open(0);
    if (!mixer) {
        fprintf(stderr, "mixer open failed\n");
        return;
    }
    struct mixer_ctl *playback = mixer_get_ctl_by_name(mixer, "Master Playback Switch");
    if (playback) {
        const unsigned int count = mixer_ctl_get_num_values(playback);
        for (unsigned int index = 0; index < count; index++) mixer_ctl_set_value(playback, index, 1);
    }
    struct mixer_ctl *output_mode = mixer_get_ctl_by_name(mixer, "Audio Mono/Stereo In/Out Mode");
    if (output_mode && mixer_ctl_set_enum_by_string(output_mode, "mono out(channel copy stereo)") != 0) {
        fprintf(stderr, "speaker mono route failed\n");
    }
    mixer_close(mixer);
}

static void play_client(int client, unsigned int device, const char *token) {
    struct pcm_config config;
    memset(&config, 0, sizeof(config));
    config.channels = 1;
    config.rate = 8000;
    config.period_size = 800;
    config.period_count = 4;
    config.format = PCM_FORMAT_S16_LE;
    config.start_threshold = 0;
    config.stop_threshold = 0;
    config.silence_threshold = 0;

    if (!authenticated(client, token)) return;
    enable_speaker_route();
    struct pcm *pcm = pcm_open(0, device, PCM_OUT, &config);
    if (!pcm || !pcm_is_ready(pcm)) {
        fprintf(stderr, "pcm open failed: %s\n", pcm ? pcm_get_error(pcm) : "allocation failed");
        if (pcm) pcm_close(pcm);
        return;
    }

    unsigned char audio[AUDIO_BYTES];
    while (running) {
        const ssize_t count = recv(client, audio, sizeof(audio), 0);
        if (count <= 0) break;
        if (pcm_write(pcm, audio, (unsigned int)(count & ~1U)) != 0) {
            fprintf(stderr, "pcm write failed: %s\n", pcm_get_error(pcm));
            break;
        }
    }
    pcm_close(pcm);
}

int main(int argc, char **argv) {
    const char *token = argc > 1 ? argv[1] : "";
    const unsigned int port = argc > 2 ? (unsigned int)strtoul(argv[2], NULL, 10) : DEFAULT_PORT;
    const unsigned int device = argc > 3 ? (unsigned int)strtoul(argv[3], NULL, 10) : 0;
    if (strlen(token) < 24 || port < 1024 || port > 65535) {
        fprintf(stderr, "usage: talkd <token-min-24-chars> [port] [alsa-device]\n");
        return 2;
    }

    signal(SIGINT, stop_server);
    signal(SIGTERM, stop_server);
    signal(SIGPIPE, SIG_IGN);
    const int server = socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) { perror("socket"); return 1; }
    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons((unsigned short)port);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(server, 2) < 0) {
        perror("listen"); close(server); return 1;
    }

    while (running) {
        const int client = accept(server, NULL, NULL);
        if (client < 0) { if (errno == EINTR) continue; perror("accept"); break; }
        play_client(client, device, token);
        close(client);
    }
    close(server);
    return 0;
}
