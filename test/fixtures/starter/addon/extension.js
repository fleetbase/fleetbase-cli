import { MenuItem, Widget, ExtensionComponent } from '@fleetbase/ember-core/contracts';

export default {
    setupExtension(app, universe) {
        const menuService = universe.getService('universe/menu-service');

        // Register in header menu
        menuService.registerHeaderMenuItem('Starter', 'console.starter', {
            icon: 'layer-group',
            priority: 5,
            description: 'Samle starter extension for developing in Fleetbase.',
            shortcuts: [],
        });
    }
};
