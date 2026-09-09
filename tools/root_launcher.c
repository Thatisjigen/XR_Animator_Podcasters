#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <limits.h>

int main(int argc, char *argv[]) {
    char exe_path[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
    if (len == -1) {
        perror("readlink");
        return 1;
    }
    exe_path[len] = '\0';

    char *dir = dirname(exe_path);

    char target_launcher[PATH_MAX];
    snprintf(target_launcher, sizeof(target_launcher), "%s/release/XR_Animator_Bundled/XR_Animator", dir);

    if (access(target_launcher, X_OK) != 0) {
        fprintf(stderr, "XR Animator bundled non trovato. Esegui: python3 tools/build_bundled_browser.py\n");
        return 1;
    }

    argv[0] = target_launcher;
    execv(target_launcher, argv);
    perror("execv XR_Animator bundled");
    return 1;
}
