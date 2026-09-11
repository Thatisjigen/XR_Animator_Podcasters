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

    /*
     * Native Wayland lets Chromium hand getDisplayMedia() straight to the
     * xdg-desktop-portal picker.  Running through XWayland instead produces a
     * Chromium picker followed by the portal picker (and Wayland windows
     * cannot be enumerated reliably by the first one).
     */
    const char *session_type = getenv("XDG_SESSION_TYPE");
    const int use_wayland =
        (session_type && strcmp(session_type, "wayland") == 0) ||
        getenv("WAYLAND_DISPLAY") != NULL ||
        getenv("NIRI_SOCKET") != NULL;

    char **new_argv = malloc((argc + 5) * sizeof(char *));
    if (!new_argv) {
        perror("malloc");
        return 1;
    }
    new_argv[0] = browser_path;
    new_argv[1] = user_data_arg;
    int next_arg = 2;
    if (use_wayland) {
        /*
         * Chromium's Ozone Wayland backend cannot run with Vulkan enabled:
         * "wayland_surface_factory.cc: '--ozone-platform=wayland' is not
         * compatible with Vulkan". Vulkan is disabled ONLY on this Wayland
         * path; native X11 keeps whatever the runtime defaults to.
         *
         * "--disable-vulkan" is not a real Chromium switch (Chromium ignores
         * it), so the ozone/Vulkan conflict persisted. The check keys off the
         * "Vulkan" feature, so --disable-features=Vulkan is what actually
         * suppresses it.
         */
        new_argv[next_arg++] = "--ozone-platform=wayland";
        new_argv[next_arg++] = "--disable-features=Vulkan";
    }
    for (int i = 1; i < argc; i++) {
        new_argv[next_arg++] = argv[i];
    }
    new_argv[next_arg] = NULL;

    execv(browser_path, new_argv);
    perror("execv xra_browser");
    free(new_argv);
    return 1;
}
