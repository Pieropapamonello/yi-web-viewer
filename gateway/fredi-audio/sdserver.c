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
#include <sys/statvfs.h>
#include <sys/types.h>
#include <unistd.h>
#include <time.h>

#define RECORD_DIR "/var/tmp/sd/recordings"
#define RECORD_FLAG "/var/tmp/sd/recording.enabled"
#define RECORD_LIMIT_FILE "/var/tmp/sd/recording.limit"
#define RECORD_RESERVE_BYTES (512ULL * 1024ULL * 1024ULL)
#define SNAPSHOT_MAX_BYTES (8UL * 1024UL * 1024UL)
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
    return (length > 5 && !strcmp(name + length - 5, ".h264")) || (length > 4 && !strcmp(name + length - 4, ".jpg")) || (length > 13 && !strcmp(name + length - 13, ".h264.partial"));
}

static int authorized(const char *request, const char *secret) {
    char expected[180]; snprintf(expected, sizeof(expected), "Authorization: Bearer %s", secret);
    return strlen(secret) >= 24 && strstr(request, expected) != NULL;
}

static unsigned long long configured_limit(void) {
    FILE *file = fopen(RECORD_LIMIT_FILE, "r"); unsigned long long value = 0;
    if (file) { fscanf(file, "%llu", &value); fclose(file); }
    return value;
}

static void list_files(int client) {
    DIR *directory; struct dirent *entry; struct stat info; struct statvfs filesystem; char path[512], chunk[768];
    int first = 1, partial_files = 0, count; unsigned long long partial_bytes = 0, recording_bytes = 0, total_bytes = 0, free_bytes = 0;
    mkdir(RECORD_DIR, 0755); directory = opendir(RECORD_DIR);
    if (!statvfs(RECORD_DIR, &filesystem)) { total_bytes = (unsigned long long)filesystem.f_blocks * filesystem.f_frsize; free_bytes = (unsigned long long)filesystem.f_bavail * filesystem.f_frsize; }
    count = snprintf(chunk, sizeof(chunk), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{\"recording\":%s,\"now\":%lu,\"totalBytes\":%llu,\"freeBytes\":%llu,\"maxBytes\":%llu,\"reserveBytes\":%llu,\"files\":[", access(RECORD_FLAG, F_OK) == 0 ? "true" : "false", (unsigned long)time(NULL), total_bytes, free_bytes, configured_limit(), RECORD_RESERVE_BYTES); send(client, chunk, count, 0);
    if (directory) while ((entry = readdir(directory))) {
        if (!safe_name(entry->d_name)) continue;
        snprintf(path, sizeof(path), "%s/%s", RECORD_DIR, entry->d_name); if (stat(path, &info)) continue;
        if (strstr(entry->d_name, ".partial")) { partial_files++; partial_bytes += (unsigned long long)info.st_size; continue; }
        recording_bytes += (unsigned long long)info.st_size;
        count = snprintf(chunk, sizeof(chunk), "%s{\"name\":\"%s\",\"size\":%lu,\"mtime\":%lu}", first ? "" : ",", entry->d_name, (unsigned long)info.st_size, (unsigned long)info.st_mtime); if (send(client, chunk, count, 0) <= 0) break; first = 0;
    }
    if (directory) closedir(directory);
    count = snprintf(chunk, sizeof(chunk), "],\"recordingBytes\":%llu,\"partialFiles\":%d,\"partialBytes\":%llu}", recording_bytes, partial_files, partial_bytes); send(client, chunk, count, 0);
}

static void serve_file(int client, const char *name) {
    char path[512], header[512], data[BUFFER_SIZE]; struct stat info; ssize_t count; int file;
    if (!safe_name(name)) { response(client, 404, "application/json", "{\"error\":\"not found\"}"); return; }
    snprintf(path, sizeof(path), "%s/%s", RECORD_DIR, name); file = open(path, O_RDONLY);
    if (file < 0 || fstat(file, &info)) { if (file >= 0) close(file); response(client, 404, "application/json", "{\"error\":\"not found\"}"); return; }
    count = snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lu\r\nCache-Control: private, no-store\r\nConnection: close\r\n\r\n", strstr(name, ".jpg") ? "image/jpeg" : "video/h264", (unsigned long)info.st_size); send(client, header, count, 0);
    while ((count = read(file, data, sizeof(data))) > 0) if (send(client, data, count, 0) <= 0) break;
    close(file);
}

static int content_length(const char *request) {
    const char *header = strstr(request, "Content-Length:");
    if (!header) header = strstr(request, "content-length:");
    return header ? atoi(header + 15) : 0;
}

static int store_snapshot(int client, const char *name, char *request, ssize_t received) {
    char path[600], temporary[620], data[BUFFER_SIZE], *body = strstr(request, "\r\n\r\n");
    int file, expected = content_length(request), written = 0; ssize_t count;
    if (!safe_name(name) || !strstr(name, ".jpg") || expected < 1024 || expected > (int)SNAPSHOT_MAX_BYTES || !body) return 0;
    mkdir(RECORD_DIR, 0755); snprintf(path, sizeof(path), "%s/%s", RECORD_DIR, name); snprintf(temporary, sizeof(temporary), "%s.partial", path);
    file = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0644); if (file < 0) return 0;
    body += 4; count = received - (body - request); if (count > expected) count = expected;
    if (count > 0) { if (write(file, body, count) != count) { close(file); unlink(temporary); return 0; } written += count; }
    while (written < expected && (count = recv(client, data, expected - written > BUFFER_SIZE ? BUFFER_SIZE : expected - written, 0)) > 0) { if (write(file, data, count) != count) break; written += count; }
    fsync(file); close(file);
    if (written != expected || rename(temporary, path)) { unlink(temporary); return 0; }
    return 1;
}

static int save_limit(const char *request) {
    const char *field = strstr(request, "\"maxBytes\""); unsigned long long value; FILE *file;
    if (!field || !(field = strchr(field, ':'))) return 0; value = strtoull(field + 1, NULL, 10);
    if (value && (value < 2147483648ULL || value > 68719476736ULL)) return 0;
    file = fopen(RECORD_LIMIT_FILE, "w"); if (!file) return 0; fprintf(file, "%llu\n", value); fflush(file); fsync(fileno(file)); fclose(file); return 1;
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
    if (!strcmp(method, "POST") && !strcmp(path, "/record/config")) { if (save_limit(request)) response(client, 200, "application/json", "{\"ok\":true}"); else response(client, 400, "application/json", "{\"error\":\"invalid limit\"}"); return; }
    if (!strcmp(method, "POST") && sscanf(path, "/snapshots/%511s", file) == 1) { if (store_snapshot(client, file, request, count)) response(client, 200, "application/json", "{\"ok\":true}"); else response(client, 400, "application/json", "{\"error\":\"snapshot failed\"}"); return; }
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
    signal(SIGINT, stop_server); signal(SIGTERM, stop_server); signal(SIGPIPE, SIG_IGN); signal(SIGCHLD, SIG_IGN);
    server = socket(AF_INET, SOCK_STREAM, 0); if (server < 0) return 1; setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_ANY); address.sin_port = htons((unsigned short)port);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 16)) { close(server); return 1; }
    while (running) {
        client = accept(server, NULL, NULL); if (client < 0) { if (errno == EINTR) continue; break; }
        if (!fork()) { close(server); handle(client, secret); close(client); _exit(0); }
        close(client);
    }
    close(server); return 0;
}
