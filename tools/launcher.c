#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <sys/stat.h>
#include <sys/types.h>
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

    char profile_dir[PATH_MAX];
    snprintf(profile_dir, sizeof(profile_dir), "%s/.nw-profile", dir);
    mkdir(profile_dir, 0755);

    char browser_path[PATH_MAX];
    snprintf(browser_path, sizeof(browser_path), "%s/xra_browser", dir);

    char user_data_arg[PATH_MAX + 32];
    snprintf(user_data_arg, sizeof(user_data_arg), "--user-data-dir=%s", profile_dir);

    char **new_argv = malloc((argc + 2) * sizeof(char *));
    if (!new_argv) {
        perror("malloc");
        return 1;
    }
    new_argv[0] = browser_path;
    new_argv[1] = user_data_arg;
    for (int i = 1; i < argc; i++) {
        new_argv[i + 1] = argv[i];
    }
    new_argv[argc + 1] = NULL;

    execv(browser_path, new_argv);
    perror("execv xra_browser");
    free(new_argv);
    return 1;
}
