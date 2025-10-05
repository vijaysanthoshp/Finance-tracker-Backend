// Database monitoring middleware for your backend
// Add this to your backend/middleware/dbMonitoring.js

const dbMonitoring = {
  // Track query performance
  trackQuery: (query, startTime) => {
    const duration = Date.now() - startTime;
    
    // Log slow queries
    if (duration > 1000) {
      console.warn(`Slow Query: ${duration}ms - ${query}`);
    }
    
    // You can send this to Azure Application Insights if needed
    return {
      query,
      duration,
      timestamp: new Date()
    };
  },

  // Track connection pool status
  trackConnectionPool: (pool) => {
    const stats = {
      totalConnections: pool.totalCount,
      activeConnections: pool.totalCount - pool.idleCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount
    };
    
    console.log('DB Pool Stats:', stats);
    return stats;
  }
};

// Usage in your database operations
const executeQuery = async (query, params) => {
  const startTime = Date.now();
  try {
    const result = await pool.query(query, params);
    dbMonitoring.trackQuery(query, startTime);
    return result;
  } catch (error) {
    console.error('Database Error:', error);
    throw error;
  }
};

module.exports = { dbMonitoring, executeQuery };