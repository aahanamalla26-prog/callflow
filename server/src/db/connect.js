import mongoose from 'mongoose';

mongoose.set('strictQuery', true);

export async function connectDB(uri = process.env.MONGODB_URI) {
  if (!uri) throw new Error('MONGODB_URI is not set');

  mongoose.connection.on('error', (err) => console.error('[mongo] error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`[mongo] connected to ${mongoose.connection.name}`);
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
