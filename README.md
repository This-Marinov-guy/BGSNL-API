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
│   ├── common-controllers.js       # Common/public endpoints
│   ├── contest-controllers.js       # Contest registration
│   ├── Events/
│   │   ├── events-controllers.js   # Event viewing & ticket purchase
│   │   └── future-events-action-controller.js  # Event CRUD operations
│   ├── Integration/
│   │   ├── google-scripts-controllers.js  # Google Apps Script integration
│   │   ├── koko-app-data-controllers.js   # Mobile app data API
│   │   └── wordpress-controllers.js       # WordPress integration
│   ├── payments-controllers.js     # Payment & checkout handling
│   ├── security-controller.js      # Authentication & password management
│   ├── special-controller.js      # Special events/cards
│   ├── users-controllers.js       # User profile & management
│   └── Webhooks/
│       └── stripe-wh-controllers.js  # Stripe webhook handlers
├── middleware/                      # Express middleware
│   ├── authorization.js           # JWT authentication & role-based access
│   ├── axiom-logger.js            # Request/response logging to Axiom
│   ├── file-upload.js             # Single file upload (S3)
│   ├── file-resize-upload.js      # Image resize & upload (S3)
│   ├── multiple-file-upload.js    # Multiple file upload handling
│   ├── firewall.js                # Rate limiting & IP filtering
│   ├── pass-secure.js             # Password security validation
│   └── preserve-date.js          # Date preservation utilities
├── models/                         # Mongoose schemas
│   ├── User.js                     # Regular member model
│   ├── AlumniUser.js              # Alumni member model
│   ├── Event.js                    # Event model
│   ├── NonSocietyEvent.js         # Non-society event model
│   ├── Contest.js                 # Contest model
│   ├── Statistics.js              # Statistics aggregation model
│   ├── ActiveMembers.js           # Active member tracking
│   ├── TemporaryCode.js           # Temporary verification codes
│   └── Http-error.js              # Custom HTTP error class
├── routes/                         # API route definitions
│   ├── common-routes.js           # Public statistics endpoints
│   ├── contest-routes.js          # Contest registration routes
│   ├── Events/
│   │   ├── events-routes.js       # Event viewing & purchase routes
│   │   └── future-events-routes.js  # Event management routes (admin)
│   ├── Integration/
│   │   ├── google-scripts.js       # Google Apps Script routes
│   │   ├── koko-app-data.js       # Mobile app routes
│   │   └── wordpress-routes.js    # WordPress integration routes
│   ├── payments-routes.js         # Payment & checkout routes
│   ├── security-routes.js         # Authentication routes
│   ├── special-routes.js          # Special events routes
│   ├── users-routes.js            # User management routes
│   └── Webhooks/
│       └── webhook-routes.js      # Stripe webhook routes
├── services/                       # Business logic layer
│   ├── main-services/
│   │   ├── event-action-service.js    # Event business logic
│   │   ├── stripe-webhook-service.js   # Stripe webhook processing
│   │   ├── user-service.js            # User lookup & operations
│   │   └── user-stats-service.js      # User statistics generation
│   ├── side-services/
│   │   ├── stripe.js                  # Stripe API client wrapper
│   │   ├── google-calendar.js         # Google Calendar integration
│   │   ├── calendar-integration/
│   │   │   ├── calendar.js            # Calendar sync logic
│   │   │   ├── mongodb.js             # Calendar MongoDB operations
│   │   │   └── sync.js                # Calendar synchronization
│   │   └── integration/
│   │       └── wordpress-service.js   # WordPress API service
│   └── background-services/
│       ├── data-pool.js              # Event data aggregation
│       ├── email-transporter.js       # Email queue & sending
│       ├── google-spreadsheets.js     # Google Sheets integration
│       └── statistics-service.js      # Statistics recounting (background jobs)
├── util/                          # Utilities and configuration
│   ├── config/
│   │   ├── access.js              # CORS and allowed origins
│   │   ├── caches.js             # In-memory cache instances
│   │   ├── db.js                 # Database connection config
│   │   ├── defines.js            # Application constants
│   │   ├── enums.js              # Status and type enums
│   │   ├── KEYS.js               # API keys configuration
│   │   ├── LINKS.js              # External links & URLs
│   │   ├── SPREEDSHEATS.js       # Google Sheets configuration
│   │   └── stripe.js             # Stripe client factory
│   ├── functions/
│   │   ├── cloudinary.js         # Cloudinary image upload
│   │   ├── dateConvert.js        # Date conversion utilities
│   │   ├── helpers.js            # General helper functions
│   │   └── security.js           # Security & encryption utilities
│   └── private/
│       ├── manipulate-db.js       # Database migration & manipulation scripts
│       └── stripe-data.js         # Stripe data utilities
└── package.json
```

## Key Features

### Authentication & Authorization
- JWT-based authentication
- Role-based access control (Admin, Board Member, Committee Member, etc.)
- Secure password hashing with bcrypt

### Event Management
- Event creation, editing, and deletion (admin)
- Ticket pricing tiers (guest, member, active member)
- Early bird and late bird pricing
- Promocode system with Stripe integration
- Guest list management and presence tracking
- Event add-ons system
- Non-society event registration
- Calendar event synchronization
- Event statistics and ticket counting

### Payment Processing
- Stripe integration for subscriptions and tickets
- Event ticket payments (guest and member)
- Webhook handling for payment events (invoice.paid, payment_failed, etc.)
- Multi-region support (Netherlands, Belgium)
- Donation payment intents
- Customer portal for subscription management
- Subscription cancellation handling
- Background statistics updates on registration/migration

### User Management
- Member registration and profiles
- Alumni management with tier system
- Subscription management and renewal
- User-to-alumni migration
- Active member application process
- User statistics and anonymized reporting
- Calendar subscription verification

### Integrations
- **WordPress**: Blog post synchronization and retrieval
- **Google Sheets**: Automated data export for users, events, and alumni
- **Google Calendar**: Event synchronization and calendar integration
- **Google Apps Scripts**: Database collection access for external scripts
- **Mobile App (Koko)**: City-specific data API for mobile application
- **Cloudinary**: Image upload and optimization
- **AWS S3**: File storage for tickets, user images, and documents
- **Stripe**: Payment processing with multi-region support (Netherlands, Belgium)
- **Axiom**: Centralized logging and monitoring (optional)

## API Endpoints

### Authentication & Security
- `POST /api/security/check-email` - Check if email exists
- `POST /api/security/check-member-key` - Verify member key
- `POST /api/security/signup` - Regular member registration
- `POST /api/security/alumni-signup` - Alumni registration
- `POST /api/security/login` - User login
- `POST /api/security/send-password-token` - Request password reset
- `POST /api/security/verify-token` - Verify password reset token
- `PATCH /api/security/change-password` - Change user password
- `PATCH /api/security/force-change-password` - Admin force password change

### Users
- `GET /api/user/current` - Get current user profile
- `GET /api/user/get-subscription-status` - Get subscription status
- `GET /api/user/refresh-token` - Refresh JWT token
- `GET /api/user/roles` - Get current user roles
- `PATCH /api/user/edit-info` - Update user profile
- `POST /api/user/active-member` - Submit active member application
- `DELETE /api/user/cancel-membership` - Cancel subscription
- `POST /api/user/verify-calendar-subscription` - Verify calendar subscription
- `GET /api/user/export-vital-stats` - Export anonymized user statistics (XLS)
- `POST /api/user/convert-to-alumni` - Convert user to alumni (admin)
- `PATCH /api/user/alumni-quote` - Update alumni quote
- `GET /api/user/active-alumni` - Get active alumni members

### Events
**Public Event Endpoints:**
- `GET /api/event/events-list` - List all events
- `GET /api/event/event-details/:eventId` - Get event details
- `GET /api/event/get-purchase-status/:eventId` - Check purchase availability
- `GET /api/event/sold-ticket-count/:eventId` - Get sold ticket count
- `GET /api/event/check-member/:userId/:eventId` - Check member eligibility
- `POST /api/event/check-guest-discount/:eventId` - Check guest discount eligibility
- `POST /api/event/purchase-ticket/guest` - Purchase guest ticket
- `POST /api/event/purchase-ticket/member` - Purchase member ticket (authenticated)
- `POST /api/event/register/non-society-event` - Register for non-society event
- `POST /api/event/sync-calendar-events` - Sync events to calendar
- `PATCH /api/event/check-guest-list` - Update guest presence (admin)

**Event Management (Admin):**
- `GET /api/future-event/full-data-events-list` - Get full event data list
- `GET /api/future-event/full-event-details/:eventId` - Get full event details
- `POST /api/future-event/add-event` - Create new event (admin)
- `PATCH /api/future-event/edit-event/:eventId` - Update event (admin)
- `DELETE /api/future-event/delete-event/:eventId` - Delete event (admin)

### Payments
- `GET /api/payment/donation/config` - Get donation configuration
- `POST /api/payment/donation/create-payment-intent` - Create donation payment intent
- `POST /api/payment/checkout/general` - General checkout session
- `POST /api/payment/checkout/member-ticket` - Member ticket checkout (authenticated)
- `POST /api/payment/checkout/guest-ticket` - Guest ticket checkout
- `POST /api/payment/checkout/signup` - Membership signup checkout
- `POST /api/payment/subscription/general` - General subscription (legacy)
- `POST /api/payment/subscription/customer-portal` - Stripe customer portal (authenticated)

### Webhooks
- `POST /api/webhooks/stripe` - Stripe webhook handler (raw body)

### Common/Public
- `GET /api/common/get-total-member-count` - Get total member count
- `GET /api/common/get-member-count` - Get active member count
- `GET /api/common/get-active-member-count` - Get active member count (with roles)
- `GET /api/common/get-about-data` - Get about us statistics

### Contests
- `POST /api/contest/register` - Register for contest

### Special Events
- `POST /api/special/add-card` - Add special event card

### Integrations

**WordPress:**
- `GET /api/wordpress/posts` - Get WordPress posts list
- `GET /api/wordpress/posts/:postId` - Get WordPress post details

**Mobile App (Koko):**
- `GET /api/mobile/:city` - Get city data for mobile app (password protected)

**Google Scripts:**
- `GET /api/google-scripts/collections/:collection` - Read database collection (password protected)

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
- Graceful shutdown with log flushing

**Configuration:**
1. Create an account at [Axiom](https://axiom.co/)
2. Create a dataset named `api-logs`
3. Generate an API token with ingest permissions
4. Add credentials to `.env` file:
   ```env
   AXIOM_TOKEN=your-axiom-api-token
   AXIOM_ORG_ID=your-axiom-organization-id
   AXIOM_DATASET=api-logs
   ```

**Note**: Axiom logging is optional and the application will run without it. The server includes graceful shutdown handlers that flush pending logs before exit.

## Background Services

The API uses background job processing for non-blocking operations:

- **Email Queue**: Asynchronous email sending with concurrency limits
- **Statistics Updates**: Member and alumni count recounting runs as background jobs
- **Spreadsheet Updates**: Google Sheets synchronization happens asynchronously
- **Event Statistics**: Event count and ticket statistics updated in background

Background jobs use `setImmediate()` to ensure they don't block API responses.

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
