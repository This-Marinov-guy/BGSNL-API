module.exports = {
  apps: [
    {
      name: "BGSNL-API",
      script: "./app.js",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      instances: 2, // Changed from "max" to 2
      exec_mode: "cluster",
      max_memory_restart: "300M",
      error_file: "/usr/src/app/logs/error.log",
      out_file: "/usr/src/app/logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};