/** Standards Section 3.10 - Typography. Single typeface family, max 4 weights, fixed type scale. */
export const fontFamily = "'Cairo', 'Inter', system-ui, sans-serif"; // Cairo per Majaal brand guide (Arabic + Latin)

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const typeScale = {
  h1: '30px', // 28-32px
  h2: '23px', // 22-24px
  h3: '19px', // 18-20px
  body: '14.5px', // 14-15px
  caption: '12px', // 11-12px
} as const;
