# Seeding Vehicle Makes and Models

This guide explains how to seed the vehicle taxonomy (makes and models) into the CarEx database.

## Prerequisites

- MongoDB connection string in `.env`:
  ```
  MONGODB_URI=mongodb://localhost:27017
  ```
  (Or your production/staging MongoDB URI)

## Running the Seed Script

From the `carEx-services` directory:

```bash
# Seed vehicles (adds to existing data - may fail on duplicate slugs)
node seed-vehicle-taxonomy.js

# Seed with fresh start (drops vehicle_makes and vehicle_models, then seeds)
node seed-vehicle-taxonomy.js --drop
```

**Use `--drop`** when you want to replace all vehicle data. This removes existing makes and models before seeding.

## Adding New Vehicles

### 1. Edit the TAXONOMY

Open `seed-vehicle-taxonomy.js` and add entries to the `TAXONOMY` array:

```javascript
const TAXONOMY = [
  // ... existing entries ...
  {
    make: 'Make Name',
    models: ['Model 1', 'Model 2', 'Model 3'],
  },
];
```

**Format:**
- `make` – Brand name (e.g. `'Hyundai'`, `'Mercedes-Benz'`)
- `models` – Array of model names for that make

### 2. Slug Generation

Slugs are auto-generated from names:
- Lowercase
- Spaces → hyphens
- Special characters removed

Examples: `Mercedes-Benz` → `mercedes-benz`, `Land Rover` → `land-rover`

### 3. Logo Support

The mobile app fetches make logos from the [avto-dev/vehicle-logotypes](https://github.com/avto-dev/vehicle-logotypes) CDN using the slug.

If a make's slug doesn't match the CDN (e.g. rebranded companies), add a slug override in the mobile app at `carEx/src/utils/makeLogos.ts`:

```javascript
const SLUG_OVERRIDES: Record<string, string> = {
  'kg-mobility': 'ssangyong',           // KG Mobility → SsangYong logo
  samsung: 'renault-samsung-motors',    // Samsung Motors → Renault Samsung logo
};
```

### 4. Re-run the Seed

```bash
node seed-vehicle-taxonomy.js --drop
```

## Example: Adding a New Make

```javascript
// In seed-vehicle-taxonomy.js, add to TAXONOMY:
{ make: 'NewBrand', models: ['Model A', 'Model B', 'Model C'] },
```

## Notes

- **Duplicate slugs**: If a make with the same slug already exists, the seed will fail. Use `--drop` to start fresh, or manually remove the conflicting make from the database first.
- **Existing car listings**: Using `--drop` only affects `vehicle_makes` and `vehicle_models`. Car listings reference makes/models by ID; if you drop and reseed, existing listings may reference orphaned IDs. Consider backing up or migrating listing data if needed.
- **Order**: Makes are seeded in array order. Models within each make are seeded in the order listed.
