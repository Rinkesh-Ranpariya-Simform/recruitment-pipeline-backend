import 'dotenv/config';
import cors from 'cors';
import express from 'express';

const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001';

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    message: 'My API is working!',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
