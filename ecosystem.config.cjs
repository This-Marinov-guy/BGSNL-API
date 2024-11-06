export default {
  apps: [
    {
      name: "BGSNL-API",
      script: "./app.js",
      env: {
        NODE_ENV: "production",
      },
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "300M",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
