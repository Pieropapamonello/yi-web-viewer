#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#define SSP_DEVICE "/dev/ssp"
#define SSP_MOVE 2
#define SSP_STOP 3
#define SSP_SET_TIMING 5
#define DEFAULT_PORT 23459

struct ssp_move {
    int32_t reserved0, reserved1, direction, step_mode, travel;
    int32_t reserved5, reserved6, reserved7;
};

static volatile sig_atomic_t running = 1;

static void stop_server(int signal_number) {
    (void)signal_number;
    running = 0;
}

static int read_line(int client, char *line, size_t size) {
    size_t used = 0;
    while (used + 1 < size) {
        char value;
        const ssize_t count = recv(client, &value, 1, 0);
        if (count <= 0) return 0;
        if (value == '\n') break;
        if (value != '\r') line[used++] = value;
    }
    line[used] = '\0';
    return 1;
}

static int direction_for(const char *value) {
    if (!strcmp(value, "up")) return 1;
    if (!strcmp(value, "down")) return 2;
    if (!strcmp(value, "left")) return 3;
    if (!strcmp(value, "right")) return 4;
    return -1;
}

static int execute_command(const char *command) {
    char action[16] = {0};
    long timing = 10;
    if (sscanf(command, "%15s %ld", action, &timing) < 1) return -1;
    if (timing < 5) timing = 5;
    if (timing > 40) timing = 40;

    const int fd = open(SSP_DEVICE, O_RDWR);
    if (fd < 0) return -1;
    if (!strcmp(action, "stop")) {
        const int result = ioctl(fd, SSP_STOP, NULL);
        close(fd);
        return result;
    }

    const int direction = direction_for(action);
    if (direction < 0) { close(fd); return -1; }
    int32_t timing_value = (int32_t)timing;
    if (ioctl(fd, SSP_SET_TIMING, &timing_value) < 0) { close(fd); return -1; }

    struct ssp_move move;
    memset(&move, 0, sizeof(move));
    move.direction = direction;
    move.step_mode = 0;
    move.travel = direction <= 2 ? 57600 : 160000;
    const int result = ioctl(fd, SSP_MOVE, &move);
    close(fd);
    return result;
}

int main(int argc, char **argv) {
    const char *token = argc > 1 ? argv[1] : "";
    const unsigned int port = argc > 2 ? (unsigned int)strtoul(argv[2], NULL, 10) : DEFAULT_PORT;
    if (strlen(token) < 24 || port < 1024 || port > 65535) return 2;

    signal(SIGINT, stop_server);
    signal(SIGTERM, stop_server);
    signal(SIGPIPE, SIG_IGN);
    const int server = socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) return 1;
    int reuse = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons((unsigned short)port);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(server, 4) < 0) {
        close(server);
        return 1;
    }

    while (running) {
        const int client = accept(server, NULL, NULL);
        if (client < 0) { if (errno == EINTR) continue; break; }
        char supplied[160], command[80];
        const int valid = read_line(client, supplied, sizeof(supplied)) &&
            strcmp(supplied, token) == 0 && read_line(client, command, sizeof(command));
        const int result = valid ? execute_command(command) : -1;
        send(client, result == 0 ? "OK\n" : "ERR\n", result == 0 ? 3 : 4, 0);
        close(client);
    }
    close(server);
    return 0;
}
