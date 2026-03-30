window.APP_CONFIG = Object.assign({}, window.APP_CONFIG, {
  SOCRATA_APP_TOKEN: `${process.env.SOCRATA_APP_TOKEN}`,
  SOCRATA_DOMAIN: `${process.env.SOCRATA_DOMAIN}`,
  THUNDERFOREST_API_KEY: `${process.env.THUNDERFOREST_API_KEY}`
});