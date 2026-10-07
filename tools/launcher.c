#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <limits.h>
#include <glob.h>

static void read_gpu_preference(const char *dir, char *gpu_pref, size_t max_len) {
    char profile_path[PATH_MAX];
    snprintf(profile_path, sizeof(profile_path), "%s/xra_profile.json", dir);

    FILE *f = fopen(profile_path, "r");
    if (f) {
        char buf[65536];
        size_t n = fread(buf, 1, sizeof(buf) - 1, f);
        fclose(f);
        buf[n] = '\0';
        char *p = strstr(buf, "\"gpu_preference\"");
        if (p) {
            char *colon = strchr(p, ':');
            if (colon) {
                char *quote1 = strchr(colon, '"');
                if (quote1) {
                    char *quote2 = strchr(quote1 + 1, '"');
                    if (quote2 && (size_t)(quote2 - quote1 - 1) < max_len) {
                        memcpy(gpu_pref, quote1 + 1, quote2 - quote1 - 1);
                        gpu_pref[quote2 - quote1 - 1] = '\0';
                    }
                }
            }
        }
    }
}

static void add_wayland_flags(char **new_argv, int *next_arg) {
    new_argv[(*next_arg)++] = "--ozone-platform=wayland";
    new_argv[(*next_arg)++] = "--disable-features=Vulkan";
    new_argv[(*next_arg)++] = "--enable-features=AcceleratedVideoDecodeLinuxGL,VaapiVideoDecoder,AcceleratedVideoDecodeLinuxZeroCopyGL";
}

/*
 * Wayland screen/window sharing reads the compositor's PipeWire DMA-BUFs
 * through the default EGL display. Under PRIME offload the NVIDIA EGL claims
 * that display and cannot import the iGPU buffers, so the capture never
 * starts. On X11 ANGLE renders through GLX: pinning EGL to Mesa keeps the
 * capture on the compositor's GPU and the rendering on the NVIDIA one.
 */
static void keep_capture_egl_on_compositor_gpu(void) {
    const char *mesa_vendor = "/usr/share/glvnd/egl_vendor.d/50_mesa.json";
    if (getenv("__EGL_VENDOR_LIBRARY_FILENAMES") || access(mesa_vendor, R_OK) != 0) {
        return;
    }
    setenv("__EGL_VENDOR_LIBRARY_FILENAMES", mesa_vendor, 1);
    /* launcher.js drops the override again for the bundled server. */
    setenv("XRA_EGL_VENDOR_OVERRIDE", "1", 1);
}

static void add_anti_throttling_flags(char **new_argv, int *next_arg) {
    new_argv[(*next_arg)++] = "--disable-background-timer-throttling";
    new_argv[(*next_arg)++] = "--disable-renderer-backgrounding";
    new_argv[(*next_arg)++] = "--disable-backgrounding-occluded-windows";
    new_argv[(*next_arg)++] = "--enable-gpu-rasterization";
    new_argv[(*next_arg)++] = "--enable-webaudio-input";
    new_argv[(*next_arg)++] = "--auto-accept-camera-and-microphone-capture";
    new_argv[(*next_arg)++] = "--autoplay-policy=no-user-gesture-required";
    new_argv[(*next_arg)++] = "--disable-gpu-vsync";
    new_argv[(*next_arg)++] = "--disable-frame-rate-limit";
}

static void apply_gpu_preference(const char *dir, char **new_argv, int *next_arg, int use_wayland) {
    char gpu_pref[64] = "default";
    read_gpu_preference(dir, gpu_pref, sizeof(gpu_pref));

    add_anti_throttling_flags(new_argv, next_arg);

    int has_nvidia = 0;
    int amd_count = 0;
    int total_gpus = 0;
    glob_t glob_res;
    if (glob("/sys/class/drm/card*", GLOB_NOSORT, NULL, &glob_res) == 0) {
        for (size_t i = 0; i < glob_res.gl_pathc; i++) {
            char vpath[PATH_MAX];
            snprintf(vpath, sizeof(vpath), "%s/device/vendor", glob_res.gl_pathv[i]);
            FILE *vf = fopen(vpath, "r");
            if (vf) {
                char vbuf[32] = {0};
                if (fgets(vbuf, sizeof(vbuf), vf)) {
                    total_gpus++;
                    if (strstr(vbuf, "0x10de")) has_nvidia = 1;
                    if (strstr(vbuf, "0x1002") || strstr(vbuf, "0x1022")) amd_count++;
                }
                fclose(vf);
            }
        }
        globfree(&glob_res);
    }
    int is_hybrid_nvidia = (has_nvidia && total_gpus > 1);
    int has_amd_dgpu = (amd_count > 0 && total_gpus > 1);

    if (strcmp(gpu_pref, "high-performance") == 0) {
        if (has_nvidia) {
            setenv("__NV_PRIME_RENDER_OFFLOAD", "1", 1);
            setenv("__GLX_VENDOR_LIBRARY_NAME", "nvidia", 1);
            setenv("__VK_LAYER_NV_optimus", "NVIDIA_only", 1);
            if (is_hybrid_nvidia && use_wayland) {
                new_argv[(*next_arg)++] = "--ozone-platform=x11";
                keep_capture_egl_on_compositor_gpu();
            } else if (use_wayland) {
                add_wayland_flags(new_argv, next_arg);
            }
        } else if (has_amd_dgpu) {
            setenv("DRI_PRIME", "1", 1);
            if (use_wayland) {
                add_wayland_flags(new_argv, next_arg);
            }
        } else if (use_wayland) {
            add_wayland_flags(new_argv, next_arg);
        }
        new_argv[(*next_arg)++] = "--gpu-preference=high-performance";
    } else if (strcmp(gpu_pref, "low-power") == 0) {
        unsetenv("__NV_PRIME_RENDER_OFFLOAD");
        unsetenv("__GLX_VENDOR_LIBRARY_NAME");
        unsetenv("__VK_LAYER_NV_optimus");
        setenv("DRI_PRIME", "0", 1);
        if (use_wayland) {
            add_wayland_flags(new_argv, next_arg);
        }
        new_argv[(*next_arg)++] = "--gpu-preference=low-power";
    } else {
        if (use_wayland) {
            add_wayland_flags(new_argv, next_arg);
        }
    }
}

int main(int argc, char *argv[]) {
    char exe_path[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
    if (len == -1) {
        perror("readlink");
        return 1;
    }
    exe_path[len] = '\0';

    char bundle_dir[PATH_MAX];
    snprintf(bundle_dir, sizeof(bundle_dir), "%s", dirname(exe_path));

    char runtime_dir[PATH_MAX];
    snprintf(runtime_dir, sizeof(runtime_dir), "%s/runtime", bundle_dir);

    char browser_path[PATH_MAX];
    snprintf(browser_path, sizeof(browser_path), "%s/xra_browser", runtime_dir);

    if (access(browser_path, X_OK) != 0) {
        char fallback_bundle[PATH_MAX];
        snprintf(fallback_bundle, sizeof(fallback_bundle), "%s/release/XR_Animator_Bundled", bundle_dir);
        char fallback_browser[PATH_MAX];
        snprintf(fallback_browser, sizeof(fallback_browser), "%s/runtime/xra_browser", fallback_bundle);
        if (access(fallback_browser, X_OK) == 0) {
            snprintf(bundle_dir, sizeof(bundle_dir), "%s", fallback_bundle);
            snprintf(runtime_dir, sizeof(runtime_dir), "%s/runtime", bundle_dir);
            snprintf(browser_path, sizeof(browser_path), "%s", fallback_browser);
        }
    }

    char profile_dir[PATH_MAX];
    snprintf(profile_dir, sizeof(profile_dir), "%s/.nw-profile", runtime_dir);
    mkdir(profile_dir, 0755);
    setenv("XRA_PROFILE_ROOT", bundle_dir, 1);

    char user_data_arg[PATH_MAX + 32];
    snprintf(user_data_arg, sizeof(user_data_arg), "--user-data-dir=%s", profile_dir);

    const char *session_type = getenv("XDG_SESSION_TYPE");
    const int use_wayland =
        (session_type && strcmp(session_type, "wayland") == 0) ||
        getenv("WAYLAND_DISPLAY") != NULL ||
        getenv("NIRI_SOCKET") != NULL;

    char **new_argv = malloc((argc + 36) * sizeof(char *));
    if (!new_argv) {
        perror("malloc");
        return 1;
    }
    new_argv[0] = browser_path;
    new_argv[1] = user_data_arg;
    int next_arg = 2;
    apply_gpu_preference(bundle_dir, new_argv, &next_arg, use_wayland);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--obs-debug") == 0) {
            /* Debug mode pairs the owned-camera feed with a local landmark log. */
            setenv("XRA_OBS_PREVIEW", "1", 1);
            setenv("XRA_MEDIAPIPE_LOG", "1", 1);
            continue;
        }
        if (strcmp(argv[i], "--obs-preview") == 0) {
            /* The NW.js child and its Python server inherit this opt-in. */
            setenv("XRA_OBS_PREVIEW", "1", 1);
            continue;
        }
        new_argv[next_arg++] = argv[i];
    }
    new_argv[next_arg] = NULL;

    execv(browser_path, new_argv);
    perror("execv xra_browser");
    free(new_argv);
    return 1;
}
