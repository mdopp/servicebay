
import { discoverSystemdServices } from './src/lib/discovery';

async function run() {
    try {
        console.log('Discovering services...');
        const services = await discoverSystemdServices();
        console.log('Found services:', services.length);
        for (const s of services) {
            console.log(`Service: ${s.serviceName}`);
            console.log(`  UnitFile: ${s.unitFile}`);
            console.log(`  SourcePath: ${s.sourcePath}`);
            console.log(`  Status: ${s.status}`);
        }
    } catch (e) {
        console.error(e);
    }
}

run();
