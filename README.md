BGSNL API (Express.js 4)
==============================

Part 1: Installation
-------------

Install NVM and from it install NodeJs version 20.10.*
NodeJs -v Latest - https://nodejs.org/en/download/

NPM 10.2.3

Step 1: Install npm dependencies
---------------------------------

In root do 

```cli
npm install
```

Step 2: Request the .env file as the program will crash without it
---------------------------------

Add the following environment variables to your .env file for Axiom logging:

```
# Axiom Logging
AXIOM_TOKEN=your-axiom-api-token
AXIOM_ORG_ID=your-axiom-organization-id
AXIOM_DATASET=api-logs
```

Step 3: Start the program
---------------------------------

```cli
npm run dev
```


Part 2: Key modules
-------------

### Axiom Logging

The API integrates with Axiom for request and response logging. All API requests are automatically logged with the following information:

- Request: method, URL, path, parameters, query, headers, IP address
- Response: status code, status message, headers, response time, size
- Metadata: environment, service name

For privacy and security reasons, request and response bodies for sensitive endpoints (like `/api/security` and `/api/user`) are automatically redacted.

**Note**: Axiom logging is automatically disabled in development environments (when NODE_ENV=development).

To configure Axiom logging:

1. Create an account at [Axiom](https://axiom.co/)
2. Create a dataset named `api-logs` (or customize the name in your .env file)
3. Generate an API token with ingest permissions
4. Add the token, org ID, and dataset name to your .env file