# Frontend Integration Guide - Stripe Promocodes

This guide explains what changes (if any) are needed in your frontend application to work with the new Stripe promocode system.

## TL;DR - Quick Answer

✅ **For Creating Events**: **NO CHANGES NEEDED** to your request body  
⚠️ **For Updating Events**: **MINOR CHANGE** - include `id` field to update existing promocodes  
✅ **For Displaying Events**: **NO CHANGES NEEDED** - same structure returned

## Detailed Breakdown

### 1. Creating Events with Promocodes

**Request Body Structure** (UNCHANGED):

```javascript
POST /api/events/add

{
  "region": "netherlands",
  "title": "Summer Party 2025",
  "guestPrice": 50,
  "memberPrice": 40,
  // ... other event fields
  
  "promoCodes": [
    {
      "code": "SUMMER2025",          // Required: string
      "discountType": 2,             // Required: 1=fixed amount, 2=percentage
      "discount": 15,                // Required: discount value
      "useLimit": 100,               // Optional: max redemptions
      "timeLimit": "2025-08-31",     // Optional: expiration date
      "minAmount": 20                // Optional: minimum purchase amount in euros
    }
  ]
}
```

**What happens on the backend:**
- Creates Stripe coupon restricted to this event's product
- Creates Stripe promotion code
- Stores `id` (promotion code ID) and `couponId` in database

**Response Structure** (NEW FIELDS):

```javascript
{
  "status": true,
  "event": {
    "id": "event_123",
    "product": {
      "id": "prod_stripe123",
      "promoCodes": [
        {
          "id": "promo_abc123",           // NEW: Stripe promotion code ID
          "couponId": "coupon_xyz789",    // NEW: Stripe coupon ID
          "code": "SUMMER2025",
          "discountType": 2,
          "discount": 15,
          "useLimit": 100,
          "timeLimit": "2025-08-31T00:00:00.000Z",
          "minAmount": 20,
          "active": true                  // NEW: Whether code is active
        }
      ]
    }
  }
}
```

### 2. Updating Events with Promocodes

**Two Scenarios:**

#### A. Add New Promocode (NO ID)

```javascript
PUT /api/events/:eventId

{
  "promoCodes": [
    {
      // NO "id" field = NEW promocode
      "code": "NEWCODE",
      "discountType": 1,
      "discount": 10
    }
  ]
}
```

#### B. Update Existing Promocode (WITH ID)

```javascript
PUT /api/events/:eventId

{
  "promoCodes": [
    {
      "id": "promo_abc123",       // ⚠️ INCLUDE THIS to update existing
      "code": "SUMMER2025",       // Can update the code
      "discount": 20              // Changed from 15 to 20
      // Only include fields you want to update
    }
  ]
}
```

**Important Update Behavior:**
- Promocodes WITH `id` starting with "promo_" → Updates existing
- Promocodes WITHOUT `id` → Creates new one
- Promocodes NOT in the array → Automatically deactivated in Stripe

#### C. Mixed Operations

```javascript
PUT /api/events/:eventId

{
  "promoCodes": [
    {
      "id": "promo_existing1",    // Update this one
      "discount": 25
    },
    {
      // No id = create new
      "code": "LASTMINUTE",
      "discountType": 1,
      "discount": 10
    }
    // promo_existing2 not in list = will be deactivated
  ]
}
```

### 3. Displaying Events

**No changes needed** - the response structure includes all the data you need:

```javascript
GET /api/events/:eventId

{
  "event": {
    "product": {
      "promoCodes": [
        {
          "id": "promo_abc123",
          "code": "SUMMER2025",
          "discountType": 2,
          "discount": 15,
          "useLimit": 100,
          "timeLimit": "2025-08-31T00:00:00.000Z",
          "active": true
        }
      ]
    }
  }
}
```

**Display Example:**

```jsx
{event.product?.promoCodes?.map(promo => (
  <div key={promo.id}>
    <span>{promo.code}</span>
    <span>
      {promo.discountType === 1 
        ? `€${promo.discount} off` 
        : `${promo.discount}% off`}
    </span>
    {promo.useLimit && <span>Max {promo.useLimit} uses</span>}
    {promo.timeLimit && <span>Expires: {new Date(promo.timeLimit).toLocaleDateString()}</span>}
    {!promo.active && <span className="inactive">Inactive</span>}
  </div>
))}
```

### 4. Applying Promocodes at Checkout

**Frontend Implementation:**

```javascript
// When user enters a promocode
async function applyPromocode(eventId, promocodeString, userType) {
  const response = await fetch(`/api/events/${eventId}/calculate-price`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userType: 'guest',  // or 'member' or 'activeMember'
      promocode: promocodeString
    })
  });
  
  const pricing = await response.json();
  
  if (pricing.valid) {
    console.log(`Original: €${pricing.basePrice}`);
    console.log(`Final: €${pricing.finalPrice}`);
    console.log(`You save: €${pricing.promocodeInfo.discountAmount}`);
  } else {
    console.error(pricing.error);
  }
}
```

**Expected Response:**

```javascript
{
  "valid": true,
  "basePrice": 100.00,
  "finalPrice": 85.00,
  "priceId": "price_xyz",
  "discountInfo": {
    "hasDiscount": false,
    "isEarlyBird": false,
    "isLateBird": false
  },
  "promocodeInfo": {
    "code": "SUMMER2025",
    "id": "promo_abc123",
    "couponId": "coupon_xyz789",
    "discountType": 2,
    "discount": 15,
    "discountAmount": 15.00
  },
  "currency": "EUR"
}
```

### 5. Validating Promocodes

**Client-side validation before sending to backend:**

```javascript
function validatePromocodeInput(promo) {
  const errors = [];
  
  if (!promo.code?.trim()) {
    errors.push("Code is required");
  }
  
  if (![1, 2].includes(promo.discountType)) {
    errors.push("Discount type must be 1 (fixed) or 2 (percentage)");
  }
  
  if (promo.discount < 0) {
    errors.push("Discount cannot be negative");
  }
  
  if (promo.discountType === 2 && promo.discount > 100) {
    errors.push("Percentage cannot exceed 100%");
  }
  
  return errors;
}
```

### 6. Handling Errors

**Backend will return errors if:**

```javascript
// Invalid promocode
{
  "valid": false,
  "error": "Invalid promocode"
}

// Expired promocode
{
  "valid": false,
  "error": "This promocode has expired"
}

// Minimum amount not met
{
  "valid": false,
  "error": "This promocode requires a minimum purchase of €20"
}

// Promocode inactive
{
  "valid": false,
  "error": "This promocode is no longer active"
}
```

**Frontend Error Handling:**

```javascript
if (!pricing.valid) {
  showError(pricing.error);
  // Keep showing original price
  displayPrice(pricing.basePrice);
}
```

## 🔒 Security: Product Restriction

### Important: Coupons are Product-Specific

**Each promocode is restricted to its event's Stripe product.**

This means:
- ✅ Promocode "SUMMER2025" for Event A → Only works on Event A
- ❌ Promocode "SUMMER2025" for Event A → Cannot be used on Event B
- ✅ Each event can have the same code name, but they're separate in Stripe

**In Stripe Dashboard:**
- Each coupon shows `applies_to: products: [prod_xyz123]`
- Attempting to use a coupon on a different product will fail automatically

**For your frontend:**
- You don't need to validate this - Stripe handles it automatically
- If a user somehow tries to use a code from Event A on Event B, Stripe will reject it

## TypeScript Types (Optional)

If using TypeScript, here are the updated types:

```typescript
interface Promocode {
  id?: string;              // Stripe promotion code ID (present in responses)
  couponId?: string;        // Stripe coupon ID (present in responses)
  code: string;             // The promocode string
  discountType: 1 | 2;      // 1=fixed amount, 2=percentage
  discount: number;         // Discount value
  useLimit?: number;        // Max redemptions
  timeLimit?: string;       // ISO date string
  minAmount?: number;       // Minimum purchase in euros
  active?: boolean;         // Whether code is active
}

interface CreateEventRequest {
  region: string;
  title: string;
  // ... other fields
  promoCodes?: Promocode[];
}

interface UpdateEventRequest {
  promoCodes?: Promocode[];  // Include id to update, omit to create
  // ... other fields
}

interface PricingResponse {
  valid: boolean;
  error?: string;
  basePrice: number;
  finalPrice: number;
  priceId: string;
  discountInfo: {
    hasDiscount: boolean;
    originalPrice?: number;
    discountPercentage?: number;
    isEarlyBird: boolean;
    isLateBird: boolean;
  };
  promocodeInfo?: {
    code: string;
    id: string;
    couponId: string;
    discountType: 1 | 2;
    discount: number;
    discountAmount: number;
  };
  currency: string;
}
```

## Summary Checklist

- [ ] **Creating events**: Keep existing request format (no changes)
- [ ] **Updating events**: Include `id` field when editing existing promocodes
- [ ] **Displaying events**: Handle new `id`, `couponId`, and `active` fields in responses
- [ ] **Applying promocodes**: Implement checkout flow with price calculation
- [ ] **Error handling**: Show appropriate messages for invalid/expired codes
- [ ] **UI updates**: Show "Inactive" badge for deactivated codes
- [ ] **Testing**: Test create, update, and delete flows

## Migration Notes

If you have existing frontend code that handles promocodes:

1. **Check if you're storing promocode IDs locally**
   - Old IDs were like `promo_1234567890_abc123def`
   - New IDs are like `promo_abc123` (Stripe promotion code IDs)

2. **Update any hardcoded assumptions**
   - Promocodes now require a product ID on the backend
   - Each code is restricted to one event/product

3. **Test update flows**
   - Make sure you're passing the `id` field when updating
   - Test that removed promocodes show as inactive

## Support

For issues:
- Check browser console for request/response data
- Verify the `id` field format (should start with "promo_")
- Check that dates are in ISO format
- Ensure discountType is 1 or 2 (not string)

