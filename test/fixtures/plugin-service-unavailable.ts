globalThis.fetch = async () =>
	new Response(
		JSON.stringify({
			schemaVersion: 1,
			error: { code: "service_unavailable", message: "Test plugin service is unavailable" },
		}),
		{
			status: 503,
			headers: { "content-type": "application/json" },
		},
	);
