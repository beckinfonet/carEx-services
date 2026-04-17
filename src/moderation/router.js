const express = require('express');

const router = express.Router();

// Scaffold route. Real Phase 2 routes mount behind this same router.
router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
