// alpha_fence — REQ-159 (`#1321`):让引擎 sidecar 进程把**自己**关进 seatbelt。
//
// 为什么要一个原生模块:出货 sidecar 是 Electron 的 utilityProcess(node 运行时),node 没有内置
// FFI,而 `utilityProcess.fork` 的 ForkOptions 没有任何指定可执行文件的字段,`sandbox-exec` 插不进
// 启动点(勘破 §6.6)。唯一落点 = 进程内调 libsandbox 的 `sandbox_init`,即 `sandbox-exec` 自己
// 用的那条 SPI(勘破 §6.6 P1;U1 `#1316` 在签名 + hardened runtime 的出货包里实测加载得了、调得动)。
//
// 本模块**不决定**可写集 —— profile 文本由 main 进程的 process-fence-profile.ts(单一权威)渲染、
// 试编译后经 StartCommand 交给 sidecar,这里只把那串字节原样交给内核。它做的事只有三件:
//   1. dlopen libsandbox(dyld 共享缓存里的名字;`/usr/lib/libsandbox.1.dylib` 在盘上不存在,勘破 §8.7);
//   2. dlsym `sandbox_init` 与 `sandbox_free_error`;
//   3. `apply(profile)` → `{ rc, error }`。rc ≠ 0 时 error 是 libsandbox 自己的编译/应用错误原文
//      (例如 `data object length 70173 exceeds maximum (65535)`),调用方据此 fail-closed。
//
// 失败方向全部响亮:dlopen / dlsym 失败在 `apply` 里抛 JS 异常(带 dlerror 原文),不返回 rc=0。
// 头文件来自 node-api-headers(devDependency,钉版),不依赖本机装了哪个 node。
// 构建:scripts/build-fence-addon.ts(fat binary:arm64 + x86_64 同一个文件,两片缺一即构建失败)。

#define NAPI_VERSION 8
#include <node_api.h>

#include <dlfcn.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifndef ALPHA_FENCE_BUILD_ID
#define ALPHA_FENCE_BUILD_ID "unversioned"
#endif

/* libsandbox SPI(Apple 标记 deprecated,与 REQ-138 用的 sandbox-exec 同一条既有风险)。 */
typedef int (*sandbox_init_fn)(const char *profile, uint64_t flags, char **errorbuf);
typedef void (*sandbox_free_error_fn)(char *errorbuf);

static const char *LIBSANDBOX = "/usr/lib/libsandbox.1.dylib";

static napi_value throw_and_null(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

/* apply(profile: string): { rc: number, error: string } */
static napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1)
    return throw_and_null(env, "alpha_fence.apply: expected one string argument (profile)");

  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &len) != napi_ok)
    return throw_and_null(env, "alpha_fence.apply: profile must be a string");
  char *profile = (char *)malloc(len + 1);
  if (!profile) return throw_and_null(env, "alpha_fence.apply: out of memory");
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[0], profile, len + 1, &copied) != napi_ok) {
    free(profile);
    return throw_and_null(env, "alpha_fence.apply: profile must be a string");
  }

  void *lib = dlopen(LIBSANDBOX, RTLD_NOW);
  if (!lib) {
    free(profile);
    const char *why = dlerror();
    char buf[512];
    snprintf(buf, sizeof buf, "alpha_fence.apply: dlopen(%s) failed: %s", LIBSANDBOX, why ? why : "unknown");
    return throw_and_null(env, buf);
  }
  sandbox_init_fn init = (sandbox_init_fn)dlsym(lib, "sandbox_init");
  sandbox_free_error_fn free_error = (sandbox_free_error_fn)dlsym(lib, "sandbox_free_error");
  if (!init || !free_error) {
    free(profile);
    return throw_and_null(env, "alpha_fence.apply: libsandbox is missing sandbox_init / sandbox_free_error");
  }

  char *errorbuf = NULL;
  int rc = init(profile, 0, &errorbuf);
  free(profile);

  napi_value result, rc_value, error_value;
  napi_create_object(env, &result);
  napi_create_int32(env, rc, &rc_value);
  napi_set_named_property(env, result, "rc", rc_value);
  const char *error_text = errorbuf ? errorbuf : "";
  napi_create_string_utf8(env, error_text, NAPI_AUTO_LENGTH, &error_value);
  napi_set_named_property(env, result, "error", error_value);
  if (errorbuf) free_error(errorbuf);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value apply_fn, build_id, lib_name;
  napi_create_function(env, "apply", NAPI_AUTO_LENGTH, Apply, NULL, &apply_fn);
  napi_set_named_property(env, exports, "apply", apply_fn);
  napi_create_string_utf8(env, ALPHA_FENCE_BUILD_ID, NAPI_AUTO_LENGTH, &build_id);
  napi_set_named_property(env, exports, "buildId", build_id);
  napi_create_string_utf8(env, LIBSANDBOX, NAPI_AUTO_LENGTH, &lib_name);
  napi_set_named_property(env, exports, "libsandbox", lib_name);
  return exports;
}
