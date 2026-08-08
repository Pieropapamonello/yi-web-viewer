#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define SSP_DEVICE "/dev/ssp"
#define SSP_POSITION 1
#define SSP_MOVE 2
#define SSP_STOP 3
#define SSP_STATUS 4
#define SSP_SET_TIMING 5

/* Layout copied by the camera's ssp_ms41909 kernel driver. */
struct ssp_move {
    int32_t reserved0;
    int32_t reserved1;
    int32_t direction;
    int32_t step_mode;
    int32_t travel;
    int32_t reserved5;
    int32_t reserved6;
    int32_t reserved7;
};

static int direction_for(const char *value) {
    if (!strcmp(value, "up")) return 1;
    if (!strcmp(value, "down")) return 2;
    if (!strcmp(value, "left")) return 3;
    if (!strcmp(value, "right")) return 4;
    if (!strcmp(value, "stop")) return 0;
    return -1;
}

static int stop_motors(int fd) {
    return ioctl(fd, SSP_STOP, NULL);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: ptzctl <up|down|left|right|stop|position|status> [milliseconds] [timing]\n");
        return 2;
    }

    const int wants_status = !strcmp(argv[1], "status");
    const int wants_position = !strcmp(argv[1], "position");
    const int direction = (wants_status || wants_position) ? 0 : direction_for(argv[1]);
    if (direction < 0) {
        fprintf(stderr, "invalid direction\n");
        return 2;
    }

    long duration = argc > 2 ? strtol(argv[2], NULL, 10) : 180;
    long timing = argc > 3 ? strtol(argv[3], NULL, 10) : 10;
    if (duration < 40) duration = 40;
    if (duration > 1200) duration = 1200;
    if (timing < 5) timing = 5;
    if (timing > 40) timing = 40;

    const int fd = open(SSP_DEVICE, O_RDWR);
    if (fd < 0) {
        perror("open " SSP_DEVICE);
        return 1;
    }

    if (wants_status || wants_position) {
        int32_t status[8] = {0};
        const int request = wants_position ? SSP_POSITION : SSP_STATUS;
        const int result = ioctl(fd, request, status);
        if (result < 0) perror(wants_position ? "ioctl position" : "ioctl status");
        else if (wants_position) printf("x=%ld y=%ld\n", (long)status[0], (long)status[1]);
        else printf("x=%ld y=%ld\n", (long)status[6], (long)status[7]);
        close(fd);
        return result < 0 ? 1 : 0;
    }

    if (direction == 0) {
        const int result = stop_motors(fd);
        if (result < 0) perror("ioctl stop");
        close(fd);
        return result < 0 ? 1 : 0;
    }

    int32_t timing_value = (int32_t)timing;
    if (ioctl(fd, SSP_SET_TIMING, &timing_value) < 0) {
        perror("ioctl timing");
        close(fd);
        return 1;
    }

    struct ssp_move move;
    memset(&move, 0, sizeof(move));
    move.direction = direction;
    move.step_mode = 0; /* The driver maps this to its safe half-step mode. */
    move.travel = direction <= 2 ? 57600 : 160000;

    if (ioctl(fd, SSP_MOVE, &move) < 0) {
        perror("ioctl move");
        stop_motors(fd);
        close(fd);
        return 1;
    }

    usleep((useconds_t)duration * 1000);
    if (stop_motors(fd) < 0) {
        perror("ioctl stop");
        close(fd);
        return 1;
    }

    close(fd);
    return 0;
}
