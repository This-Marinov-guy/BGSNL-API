# Stripe Promocode Integration

This document explains how the Stripe promocode system has been integrated into the BGSNL API.

## Overview

The system now uses **Stripe's native Coupon and Promotion Code functionality** instead of custom promocode management. This provides better integration with Stripe's payment system and allows for automatic application of discounts during checkout.

## Architecture

### Database Schema (`models/Event.js`)

Each event's `product.promoCodes` array now stores:

```javascript
{
  id: String,              // Stripe promotion code ID (e.g., "promo_abc123")
  couponId: String,        // Stripe coupon ID (e.g., "coupon_xyz789")
  code: String,            // The actual code string (e.g., "SUMMER2025")
  discountType: Number,    // 1 = fixed amount, 2 = percentage
  discount: Number,        // Discount value (e.g., 10 for €10 or 10%)
  useLimit: Number,        // Maximum number of redemptions (optional)
  timeLimit: Date,         // Expiration date (optional)
  minAmount: Number,       // Minimum purchase amount in euros (optional)
  active: Boolean          // Whether the code is active (default: true)
}
```

### Stripe Components

1. **Coupon**: Defines the discount amount/percentage and restrictions
   - Created with `createStripeCoupon(region, productId, discountType, discount, minAmount)`
   - Types: `amount_off` (fixed) or `percent_off` (percentage)
   - **IMPORTANT**: Restricted to specific event product via `applies_to.products`
   - Can have minimum amount restrictions

2. **Promotion Code**: The actual code that customers enter
   - Created with `createStripePromotionCode(region, couponId, code, useLimit, timeLimit)`
   - Linked to a coupon
   - Can have max redemptions and expiration dates

## API Functions

### Stripe Service (`services/side-services/stripe.js`)

#### Creating Promocodes

```javascript
// Create a complete promocode (coupon + promotion code)
// IMPORTANT: Promocodes are restricted to the specified productId
const processedPromocodes = await processPromocodesForCreate(region, productId, promoCodes);
```

**Input Example:**
```javascript
const promoCodes = [
  {
    code: "SUMMER2025",
    discountType: 2,        // percentage
    discount: 15,           // 15% off
    useLimit: 100,
    timeLimit: "2025-08-31T23:59:59Z",
    minAmount: 20           // minimum €20 purchase
  },
  {
    code: "WELCOME10",
    discountType: 1,        // fixed amount
    discount: 10,           // €10 off
    useLimit: 50
  }
];
```

#### Updating Promocodes

```javascript
// Update existing promocodes
// New promocodes will be restricted to the specified productId
const updatedPromocodes = await processPromocodesForUpdate(
  region,
  productId,
  newPromoCodes, 
  existingPromocodes
);
```

**Behavior:**
- If promocode has `id` starting with "promo_": Updates existing Stripe promocode
- If no `id`: Creates new Stripe promocode
- Promocodes not in the update array: Automatically deactivated in Stripe
- Discount changes: Creates new coupon and promotion code, deactivates old ones
- Code/limit/expiry changes: Creates new promotion code with same coupon

#### Individual Functions

```javascript
// Create a Stripe coupon (restricted to specific product)
const couponId = await createStripeCoupon(region, productId, discountType, discount, minAmount);

// Create a Stripe promotion code
const promoCode = await createStripePromotionCode(region, couponId, code, useLimit, timeLimit);

// Deactivate a promotion code
await deactivateStripePromotionCode(region, promoId);

// Delete a coupon (also deactivates associated promotion codes)
await deleteStripeCoupon(region, couponId);
```

### Event Action Service (`services/main-services/event-action-service.js`)

#### Validate Promocode

```javascript
const validation = validatePromocodeForPurchase(promocode, totalAmount);
```

**Returns:**
```javascript
{
  valid: true/false,
  reason: "Error message if invalid",
  discountedAmount: 85.00,
  discountAmount: 15.00
}
```

**Checks:**
- ✓ Promocode is active
- ✓ Not expired (timeLimit)
- ✓ Meets minimum purchase amount (minAmount)

#### Find Promocode by Code

```javascript
const promocode = findPromocodeByCode(event, "SUMMER2025");
```

#### Calculate Final Price

```javascript
const pricing = calculateFinalPrice(event, userType, promocodeString);
```

**Input:**
- `event`: Event object
- `userType`: "guest", "member", or "activeMember"
- `promocodeString`: Optional promocode (e.g., "SUMMER2025")

**Returns:**
```javascript
{
  valid: true,
  basePrice: 100.00,          // Price after early/late bird discounts
  finalPrice: 85.00,          // Price after promocode
  priceId: "price_xyz",
  discountInfo: {
    hasDiscount: false,
    originalPrice: undefined,
    discountPercentage: undefined,
    isEarlyBird: false,
    isLateBird: false
  },
  promocodeInfo: {
    code: "SUMMER2025",
    id: "promo_abc123",
    couponId: "coupon_xyz789",
    discountType: 2,
    discount: 15,
    discountAmount: 15.00
  },
  currency: "EUR"
}
```

#### Get Applicable Price

```javascript
const priceInfo = getApplicablePrice(event, userType);
```

Gets the price for a user type after applying early bird, late bird, and promotion discounts (but before promocode).

## Event Controllers (`controllers/Events/future-events-action-controller.js`)

### Creating Events with Promocodes

```javascript
// In addEvent controller
const processedPromocodes = await processPromocodesForCreate(region, promoCodes);
if (processedPromocodes.length > 0) {
  product.promoCodes = processedPromocodes;
}
```

### Updating Events with Promocodes

```javascript
// In editEvent controller
if (event?.product) {
  event.product.promoCodes = await processPromocodesForUpdate(
    region,
    promoCodes,
    event.product.promoCodes
  );
}
```

## Discount Hierarchy

The system applies discounts in this order:

1. **Early Bird / Late Bird**: Adjusts base price based on timing/ticket count
2. **Promotions**: Time-based percentage discounts for guest/member
3. **Promocodes**: Applied to the adjusted price from steps 1-2

Example flow:
```
Base Price: €100
→ Early Bird (20% off): €80
→ Promocode "SAVE10" (€10 off): €70
Final Price: €70
```

## Usage Examples

### Create Event with Promocodes

```javascript
POST /api/events/add
{
  "region": "netherlands",
  "title": "Summer Party 2025",
  "guestPrice": 50,
  "memberPrice": 40,
  "promoCodes": [
    {
      "code": "EARLYBIRD",
      "discountType": 2,
      "discount": 20,
      "useLimit": 50,
      "timeLimit": "2025-07-01T00:00:00Z"
    }
  ],
  // ... other event data
}
```

### Update Event Promocodes

```javascript
PUT /api/events/:eventId
{
  "promoCodes": [
    {
      "id": "promo_existing123",  // Keep and update this one
      "code": "EARLYBIRD",
      "discount": 25              // Changed from 20% to 25%
    },
    {
      // No id = new promocode
      "code": "LASTMINUTE",
      "discountType": 1,
      "discount": 15
    }
  ]
  // Promocodes not in this array will be deactivated
}
```

### Validate and Apply Promocode at Checkout

```javascript
import { calculateFinalPrice } from './services/main-services/event-action-service.js';

// Get event from database
const event = await Event.findById(eventId);

// Calculate price with promocode
const pricing = calculateFinalPrice(event, 'guest', 'SUMMER2025');

if (pricing.valid) {
  console.log(`Final price: €${pricing.finalPrice}`);
  console.log(`You saved: €${pricing.promocodeInfo.discountAmount}`);
  
  // Create Stripe checkout session with the priceId
  // The promocode will automatically be applied by Stripe
} else {
  console.log(`Error: ${pricing.error}`);
}
```

## Migration Notes

### Breaking Changes

1. **Function Signatures Changed**:
   - `processPromocodesForCreate(promoCodes)` → `processPromocodesForCreate(region, promoCodes)`
   - `processPromocodesForUpdate(promoCodes, existing)` → `processPromocodesForUpdate(region, promoCodes, existing)`

2. **Async Operations**:
   - Both functions are now `async` and must be `await`ed
   - They make API calls to Stripe

3. **Schema Changes**:
   - Added `couponId` field (required)
   - Added `active` field (default: true)
   - Removed `redeemed` field (get from Stripe API instead)

### Data Migration

Existing promocodes in the database will need to be migrated:

```javascript
// For each event with promoCodes
for (const event of events) {
  if (event.product?.promoCodes?.length > 0) {
    const newPromoCodes = [];
    
    for (const oldPromo of event.product.promoCodes) {
      // Create Stripe coupon and promotion code
      const stripePromo = await createStripePromocodeComplete(
        event.region,
        oldPromo
      );
      
      if (stripePromo) {
        newPromoCodes.push(stripePromo);
      }
    }
    
    event.product.promoCodes = newPromoCodes;
    await event.save();
  }
}
```

## Testing

### Test Promocode Creation

```javascript
const testPromo = {
  code: "TEST10",
  discountType: 1,
  discount: 10,
  useLimit: 1,
  minAmount: 20
};

const result = await processPromocodesForCreate('netherlands', [testPromo]);
console.log(result);
// Should return array with Stripe promotion code ID and coupon ID
```

### Test Promocode Validation

```javascript
const event = await Event.findById(eventId);
const promocode = findPromocodeByCode(event, "TEST10");
const validation = validatePromocodeForPurchase(promocode, 25);

console.log(validation);
// Should return { valid: true, discountedAmount: 15, discountAmount: 10 }
```

## Error Handling

All Stripe operations include try-catch blocks and return `null` or `false` on failure. Check console logs for detailed error messages:

```javascript
const result = await processPromocodesForCreate(region, promoCodes);
if (!result || result.length === 0) {
  console.error('Failed to create promocodes');
  // Handle error
}
```

## Best Practices

1. **Always validate region**: Ensure the region is valid before creating promocodes
2. **Handle failures gracefully**: Promocode creation might fail, don't block event creation
3. **Check expiration**: Validate timeLimit before allowing checkout
4. **Monitor usage**: Use Stripe Dashboard to track redemptions
5. **Clean up**: Deactivate expired or unused promocodes periodically
6. **Test in development**: Use Stripe test mode for development and testing

## Stripe Dashboard

You can view and manage all promocodes in the Stripe Dashboard:

1. Navigate to: **Products > Coupons**
2. View promotion codes: **Products > Promotion codes**
3. Track redemptions and manage active codes

## Support

For issues or questions:
- Check Stripe API documentation: https://stripe.com/docs/api/promotion_codes
- Review console logs for detailed error messages
- Verify Stripe API keys are correctly configured in `util/config/stripe.js`

