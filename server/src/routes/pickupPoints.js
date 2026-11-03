const express = require('express');
const { now } = require('../db');

module.exports = function pickupPointsRouter({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    let rows;
    if (req.query.leader_id) {
      rows = db
        .prepare('SELECT * FROM pickup_points WHERE leader_id = ? ORDER BY id DESC')
        .all(Number(req.query.leader_id));
    } else {
      rows = db.prepare('SELECT * FROM pickup_points ORDER BY id DESC').all();
    }
    res.json(rows);
  });

  router.post('/', (req, res) => {
    const { name, address, contact = '' } = req.body || {};
    if (!name || !address) {
      return res.status(400).json({ error: 'name and address are required' });
    }
    const info = db
      .prepare(
        `INSERT INTO pickup_points (leader_id, name, address, contact, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(req.user.id, name, address, contact, now());
    res.status(201).json(db.prepare('SELECT * FROM pickup_points WHERE id = ?').get(info.lastInsertRowid));
  });

  // 团长更新自提点信息
  router.put('/:id', (req, res) => {
    const { name, address, contact = '' } = req.body || {};
    if (!name || !address) {
      return res.status(400).json({ error: 'name and address are required' });
    }
    const info = db
      .prepare('UPDATE pickup_points SET name = ?, address = ?, contact = ? WHERE id = ?')
      .run(name, address, contact, req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'pickup point not found' });
    res.json(db.prepare('SELECT * FROM pickup_points WHERE id = ?').get(req.params.id));
  });

  return router;
};
