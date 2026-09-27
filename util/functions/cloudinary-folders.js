const isDevelopment = (env) => env.APP_ENV
  ? env.APP_ENV !== "prod"
  : env.NODE_ENV !== "production";

export function cloudinaryFolder(folder = "", env = process.env) {
  if (!isDevelopment(env)) return folder;
  const path = String(folder || "").replace(/^\/+|\/+$/g, "");
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid Cloudinary folder");
  }
  return path === "development" || path.startsWith("development/")
    ? path
    : ["development", path].filter(Boolean).join("/");
}

export function cloudinaryUploadOptions(options = {}, env = process.env) {
  const scoped = { overwrite: true, ...options };
  if (!isDevelopment(env)) return scoped;
  scoped.folder = cloudinaryFolder(options.folder, env);
  // Explicit dynamic-folder options override `folder` in Cloudinary.
  for (const key of ["asset_folder", "public_id_prefix"]) {
    if (options[key] !== undefined) scoped[key] = cloudinaryFolder(options[key], env);
  }
  return scoped;
}
