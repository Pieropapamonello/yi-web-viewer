#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <time.h>

#define RECORD_DIR "/var/tmp/sd/recordings"
#define RECORD_FLAG "/var/tmp/sd/recording.enabled"
#define BUFFER_SIZE 16384

static volatile sig_atomic_t running = 1;
static void stop_server(int value) { (void)value; running = 0; }

static void response(int client, int status, const char *type, const char *body) {
    char header[512]; size_t length = body ? strlen(body) : 0;
    int count = snprintf(header, sizeof(header), "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", status, status == 200 ? "OK" : status == 204 ? "No Content" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : "Error", type, (unsigned long)length);
    send(client, header, count, 0); if (length) send(client, body, length, 0);
}

static int safe_name(const char *name) {
    size_t index, length = strlen(name);
    if (!length || length > 180 || strstr(name, "..")) return 0;
    for (index = 0; index < length; index++) if (!((name[index] >= 'a' && name[index] <= 'z') || (name[index] >= 'A' && name[index] <= 'Z') || (name[index] >= '0' && name[index] <= '9') || name[index] == '-' || name[index] == '_' || name[index] == '.')) return 0;
    return strstr(name, ".h264") != NULL;
}

static int authorized(const char *request, const char *secret) {
    char expected[180]; snprintf(expected, sizeof(expected), "Authorization: Bearer %s", secret);
    return strlen(secret) >= 24 && strstr(request, expected) != NULL;
}

static void list_files(int client) {
    DIR *directory; struct dirent *entry; struct stat info; char path[512];
    char *json = malloc(131072); size_t used = 0; int first = 1, partial_files = 0; unsigned long partial_bytes = 0;
    if (!json) { response(client, 500, "application/json", "{\"error\":\"memory\"}"); return; }
    mkdir(RECORD_DIR, 0755); directory = opendir(RECORD_DIR);
    used += snprintf(json + used, 131072 - used, "{\"recording\":%s,\"now\":%lu,\"files\":[", access(RECORD_FLAG, F_OK) == 0 ? "true" : "false", (unsigned long)time(NULL));
    if (directory) while ((entry = readdir(directory)) && used < 129000) {
        if (!safe_name(entry->d_name)) continue;
        snprintf(path, sizeof(path), "%s/%s", RECORD_DIR, entry->d_name); if (stat(path, &info)) continue;
        if (strstr(entry->d_name, ".partial")) { partial_files++; partial_bytes += (unsigned long)info.st_size; continue; }
        used += snprintf(json + used, 131072 - used, "%s{\"name\":\"%s\",\"size\":%lu,\"mtime\":%lu}", first ? "" : ",", entry->d_name, (unsigned long)info.st_size, (unsigned long)info.st_mtime); first = 0;
    }
    if (directory) closedir(directory); used += snprintf(json + used, 131072 - used, "],\"partialFiles\":%d,\"partialBytes\":%lu}", partial_files, partial_bytes);
    response(client, 200, "application/json", json); free(json);
}

static void serve_file(int client, const char *name) {
    char path[512], header[512], data[BUFFER_SIZE]; struct stat info; ssize_t count; int file;
    if (!safe_name(name)) { response(client, 404, "application/json", "{\"error\":\"not found\"}"); return; }
    snprintf(path, sizeof(path), "%s/%s", RECORD_DIR, name); file = open(path, O_RDONLY);
    if (file < 0 || fstat(file, &info)) { if (file >= 0) close(file); response(client, 404, "application/json", "{\"error\":\"not found\"}"); return; }
    count = snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: video/h264\r\nContent-Length: %lu\r\nCache-Control: private, no-store\r\nConnection: close\r\n\r\n", (unsigned long)info.st_size); send(client, header, count, 0);
    while ((count = read(file, data, sizeof(data))) > 0) if (send(client, data, count, 0) <= 0) break;
    close(file);
}

static void handle(int client, const char *secret) {
    char request[4096], method[12], path[512], file[512]; ssize_t count = recv(client, request, sizeof(request) - 1, 0);
    if (count <= 0) return; request[count] = '\0';
    if (sscanf(request, "%11s %511s", method, path) != 2) { response(client, 400, "application/json", "{\"error\":\"bad request\"}"); return; }
    if (!authorized(request, secret)) { response(client, 401, "application/json", "{\"error\":\"unauthorized\"}"); return; }
    if (!strcmp(method, "GET") && !strcmp(path, "/health")) { char body[256]; struct stat stream_info; long stream_size = stat("/var/tmp/sd/stream", &stream_info) ? -1 : (long)stream_info.st_size; snprintf(body, sizeof(body), "{\"ok\":true,\"streamSize\":%ld,\"recordingFlag\":%s}", stream_size, access(RECORD_FLAG, F_OK) == 0 ? "true" : "false"); response(client, 200, "application/json", body); return; }
    if (!strcmp(method, "GET") && !strcmp(path, "/list")) { list_files(client); return; }
    if (!strcmp(method, "POST") && !strcmp(path, "/record/start")) { mkdir(RECORD_DIR, 0755); close(open(RECORD_FLAG, O_WRONLY | O_CREAT, 0644)); response(client, 200, "application/json", "{\"ok\":true,\"recording\":true}"); return; }
    if (!strcmp(method, "POST") && !strcmp(path, "/record/stop")) { unlink(RECORD_FLAG); response(client, 200, "application/json", "{\"ok\":true,\"recording\":false}"); return; }
    if (sscanf(path, "/files/%511s", file) == 1) {
        if (!strcmp(method, "GET")) { serve_file(client, file); return; }
        if (!strcmp(method, "DELETE") && safe_name(file)) { char full[600]; snprintf(full, sizeof(full), "%s/%s", RECORD_DIR, file); if (!unlink(full)) { response(client, 200, "application/json", "{\"ok\":true}"); return; } }
    }
    response(client, 404, "application/json", "{\"error\":\"not found\"}");
}

int main(int argc, char **argv) {
    const char *secret = argc > 1 ? argv[1] : ""; unsigned int port = argc > 2 ? strtoul(argv[2], NULL, 10) : 23458;
    int server, client, reuse = 1; struct sockaddr_in address;
    if (strlen(secret) < 24 || port < 1024 || port > 65535) return 2;
    signal(SIGINT, stop_server); signal(SIGTERM, stop_server); signal(SIGPIPE, SIG_IGN);
    server = socket(AF_INET, SOCK_STREAM, 0); if (server < 0) return 1; setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_ANY); address.sin_port = htons((unsigned short)port);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 4)) { close(server); return 1; }
    while (running) { client = accept(server, NULL, NULL); if (client < 0) { if (errno == EINTR) continue; break; } handle(client, secret); close(client); }
    close(server); return 0;
}
