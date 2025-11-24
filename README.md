# BGSNL API

Express.js 4 REST API for Bulgarian Society Netherlands platform.

## Overview

The BGSNL API is a comprehensive backend system that handles:

- **User Management**: Member registration, authentication, and profile management
- **Event Management**: Event creation, ticketing, and guest list management
- **Payment Processing**: Stripe integration for subscriptions and event tickets
- **Membership Management**: Active members, alumni, and subscription handling
- **Integration Services**: WordPress, Google Sheets, Cloudinary, S3 buckets

## Installation

### Prerequisites

- **Node.js**: Version 20.10.* (recommended via NVM)
- **NPM**: Version 10.2.3
- **MongoDB**: Database connection string
- **Stripe Account**: For payment processing

### Step 1: Install Node.js

Install NVM (Node Version Manager) and use it to install Node.js 20.10.*:

```bash
# Install NVM (if not already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install Node.js 20.10.*
nvm install 20.10.0
nvm use 20.10.0
```

Or download directly from [nodejs.org](https://nodejs.org/en/download/)

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Environment Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Database
DB_USER=your-mongodb-username
DB_PASS=your-mongodb-password
DB=your-mongodb-cluster-url

# JWT
JWT_SECRET=your-jwt-secret-key

# Stripe
STRIPE_SECRET_KEY_NETHERLANDS=your-stripe-secret-key
STRIPE_SECRET_KEY_BELGIUM=your-stripe-secret-key

# Server
PORT=5000
NODE_ENV=development

# Axiom Logging (Optional)
AXIOM_TOKEN=your-axiom-api-token
AXIOM_ORG_ID=your-axiom-organization-id
AXIOM_DATASET=api-logs
```

**Note**: Request the `.env` file from the team as the application requires these environment variables to run.

### Step 4: Start the Application

**Development mode:**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The API will be available at `http://localhost:5000` (or the port specified in your `.env` file).

## Project Structure

```
BGSNL-API/
├── app.js                          # Main application entry point
├── controllers/                     # Request handlers
│   ├── common-controllers.js
│   ├── contest-controllers.js
│   ├── Events/
│   │   ├── events-controllers.js
│   │   └── future-events-action-controller.js
│   ├── Integration/
│   │   ├── google-scripts-controllers.js
│   │   ├── koko-app-data-controllers.js
│   │   └── wordpress-controllers.js
│   ├── payments-controllers.js
│   ├── security-controller.js
│   ├── special-controller.js
│   ├── users-controllers.js
│   └── Webhooks/
│       └── stripe-wh-controllers.js
├── middleware/                      # Express middleware
│   ├── authorization.js           # JWT authentication
│   ├── axiom-logger.js            # Request logging
│   ├── file-upload.js             # File upload handling
│   ├── firewall.js                # Rate limiting & security
│   └── pass-secure.js             # Password validation
├── models/                         # Mongoose schemas
│   ├── User.js
│   ├── AlumniUser.js
│   ├── Event.js
│   ├── Contest.js
│   └── ...
├── routes/                         # API route definitions
│   ├── users-routes.js
│   ├── Events/
│   ├── payments-routes.js
│   ├── security-routes.js
│   └── ...
├── services/                       # Business logic
│   ├── main-services/
│   │   ├── event-action-service.js
│   │   ├── stripe-webhook-service.js
│   │   ├── user-service.js
│   │   └── user-stats-service.js
│   ├── side-services/
│   │   ├── stripe.js              # Stripe integration
│   │   ├── google-calendar.js
│   │   └── integration/
│   └── background-services/
│       ├── email-transporter.js
│       └── google-spreadsheets.js
├── util/                          # Utilities and configuration
│   ├── config/
│   │   ├── access.js              # CORS and access control
│   │   ├── db.js                  # Database connection
│   │   ├── defines.js             # Constants and enums
│   │   ├── enums.js               # Status enums
│   │   ├── KEYS.js                # API keys
│   │   └── stripe.js              # Stripe client setup
│   ├── functions/
│   │   ├── cloudinary.js          # Image upload
│   │   ├── dateConvert.js         # Date utilities
│   │   ├── helpers.js             # Helper functions
│   │   └── security.js            # Security utilities
│   └── private/
│       └── manipulate-db.js       # Database migration scripts
└── package.json
```

## Key Features

### Authentication & Authorization
- JWT-based authentication
- Role-based access control (Admin, Board Member, Committee Member, etc.)
- Secure password hashing with bcrypt

### Event Management
- Event creation and editing
- Ticket pricing (guest, member, active member)
- Early bird and late bird pricing
- Promocode system with Stripe integration
- Guest list management
- Event add-ons

### Payment Processing
- Stripe integration for subscriptions
- Event ticket payments
- Webhook handling for payment events
- Multi-region support (Netherlands, Belgium)

### User Management
- Member registration and profiles
- Alumni management
- Subscription management
- User statistics and reporting

### Integrations
- WordPress synchronization
- Google Sheets data export
- Google Calendar integration
- Mobile app data API

## API Endpoints

### Authentication
- `POST /api/security/login` - User login
- `POST /api/security/register` - User registration
- `POST /api/security/refresh` - Refresh JWT token

### Users
- `GET /api/user` - Get user profile
- `PUT /api/user` - Update user profile
- `GET /api/user/stats` - Get user statistics

### Events
- `GET /api/events` - List all events
- `POST /api/events/add` - Create new event
- `PUT /api/events/:eventId` - Update event
- `DELETE /api/events/:eventId` - Delete event

### Payments
- `POST /api/payments/create-checkout` - Create Stripe checkout session
- `POST /api/webhooks/stripe` - Stripe webhook handler

## Development

### Available Scripts

```bash
npm run dev      # Start development server with nodemon
npm start        # Start production server
npm run lint     # Run ESLint
```

### Code Style

The project uses ESLint for code quality. Run linting with:

```bash
npm run lint
```

## Logging

### Axiom Integration (Optional)

The API integrates with Axiom for centralized logging. Axiom logging is automatically disabled in development environments.

**Features:**
- Automatic request/response logging
- Sensitive data redaction for security endpoints
- Performance metrics (response time, size)
- Environment-aware logging

**Configuration:**
1. Create an account at [Axiom](https://axiom.co/)
2. Create a dataset named `api-logs`
3. Generate an API token with ingest permissions
4. Add credentials to `.env` file

**Note**: Axiom logging is optional and the application will run without it.

## Security

- Rate limiting on production
- Firewall protection
- CORS configuration
- Request body size limits
- Secure password storage
- JWT token expiration

## License

ISC

## Support

For issues or questions, contact the development team at technology@bulgariansociety.nl .
